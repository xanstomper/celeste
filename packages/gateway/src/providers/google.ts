import type { ChatMessage, ToolCall } from '@celeste/protocol';
import { httpRequest, withRetry } from '../http.js';
import { ProviderError, toJsonSchema } from '../types.js';
import type { ChatRequest, ChatResponse, ModelProvider, ProviderConfig } from '../types.js';

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string; status?: string };
}

/**
 * Adapter for Google Gemini's `generateContent` endpoint.
 */
export class GoogleProvider implements ModelProvider {
  constructor(readonly config: ProviderConfig) {}

  private get baseUrl(): string {
    return (this.config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/+$/,
      '',
    );
  }

  private resolveKey(): string | undefined {
    if (this.config.apiKey) return this.config.apiKey;
    if (this.config.apiKeyEnv) return process.env[this.config.apiKeyEnv];
    return undefined;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { contents, systemInstruction } = toGeminiPayload(request.messages);
    const body: Record<string, unknown> = { contents };

    if (systemInstruction) body.system_instruction = systemInstruction;

    const generationConfig: Record<string, unknown> = {};
    const temperature = request.temperature ?? this.config.temperature;
    if (temperature !== undefined) generationConfig.temperature = temperature;
    const maxTokens = request.maxTokens ?? this.config.maxTokens;
    if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    const tools = request.tools ?? [];
    if (tools.length > 0 && (this.config.supportsTools ?? true)) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: stripUnsupported(toJsonSchema(t.parameters) as unknown as Record<string, unknown>),
          })),
        },
      ];
    }

    if (this.config.extraBody) Object.assign(body, this.config.extraBody);
    if (request.extraBody) Object.assign(body, request.extraBody);

    const key = this.resolveKey();
    const url = key
      ? `${this.baseUrl}/models/${this.config.model}:generateContent?key=${encodeURIComponent(key)}`
      : `${this.baseUrl}/models/${this.config.model}:generateContent`;

    const res = await withRetry(async () => {
      const response = await httpRequest({
        url,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.config.headers ?? {}) },
        body,
        signal: request.signal,
      });
      if (!response.ok) {
        throw new ProviderError(
          this.config.id,
          `Gemini request failed [${response.status}]: ${response.text.slice(0, 300)}`,
          { status: response.status, retryable: response.status === 429 || response.status >= 500 },
        );
      }
      return response;
    });

    const payload = res.json<GeminiResponse>();
    if (payload.error) {
      throw new ProviderError(this.config.id, payload.error.message ?? 'Gemini error');
    }

    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? '').join('');

    const toolCalls: ToolCall[] = [];
    for (const part of parts) {
      const fc = (part as GeminiPart & { functionCall?: { name?: string; args?: unknown } }).functionCall;
      if (fc?.name) {
        toolCalls.push({
          id: `call_${toolCalls.length}`,
          name: fc.name,
          arguments: (fc.args as Record<string, unknown>) ?? {},
        });
      }
    }

    const message: ChatMessage = {
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return {
      message,
      toolCalls,
      finishReason: payload.candidates?.[0]?.finishReason,
      usage: payload.usageMetadata
        ? {
            promptTokens: payload.usageMetadata.promptTokenCount,
            completionTokens: payload.usageMetadata.candidatesTokenCount,
            totalTokens: payload.usageMetadata.totalTokenCount,
          }
        : undefined,
      providerId: this.config.id,
      model: this.config.model,
    };
  }
}

function toGeminiPayload(messages: ChatMessage[]): {
  contents: unknown[];
  systemInstruction?: { parts: { text: string }[] };
} {
  const contents: unknown[] = [];
  const systemParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(typeof msg.content === 'string' ? msg.content : flattenText(msg.content));
      continue;
    }
    if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ text: `Tool result for ${msg.toolCallId ?? ''}: ${flattenText(msg.content)}` }],
      });
      continue;
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const parts: GeminiPart[] = [];
      const text = flattenText(msg.content);
      if (text) parts.push({ text });
      for (const tc of msg.toolCalls) {
        (parts as unknown as Record<string, unknown>[]).push({
          functionCall: { name: tc.name, args: tc.arguments },
        });
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    const parts: GeminiPart[] =
      typeof msg.content === 'string'
        ? [{ text: msg.content }]
        : msg.content.map((part) =>
            part.type === 'text'
              ? { text: part.text }
              : { inline_data: { mime_type: part.mimeType, data: part.data } },
          );
    contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
  }

  return {
    contents,
    ...(systemParts.length > 0
      ? { systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] } }
      : {}),
  };
}

/** Gemini rejects some JSON-schema keywords; strip the common offenders. */
function stripUnsupported(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...schema };
  delete clone.additionalProperties;
  delete clone.$schema;
  delete clone.default;
  if (clone.properties && typeof clone.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(clone.properties as Record<string, unknown>)) {
      props[key] = stripUnsupported(value as Record<string, unknown>);
    }
    clone.properties = props;
  }
  if (clone.items && typeof clone.items === 'object') {
    clone.items = stripUnsupported(clone.items as Record<string, unknown>);
  }
  return clone;
}

function flattenText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n');
}
