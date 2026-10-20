import type { ChatMessage, ToolCall, ToolDefinition } from '@celeste/protocol';
import { httpRequest, withRetry } from '../http.js';
import { ProviderError, toJsonSchema } from '../types.js';
import type { ChatRequest, ChatResponse, ModelProvider, ProviderConfig } from '../types.js';

interface OpenAiToolCallRaw {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAiToolCallRaw[];
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string };
}

const DEFAULT_BASE_URL: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'http://localhost:8080/v1',
  ollama: 'http://localhost:11434',
};

/**
 * Adapter for every provider that speaks the OpenAI Chat Completions dialect.
 * This covers OpenAI itself, OpenRouter, Groq, Together, Fireworks, vLLM,
 * llama.cpp's server, LM Studio, LM Studio, Jan, LM Studio, LiteLLM proxies
 * and anything else that exposes `/chat/completions`.
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(readonly config: ProviderConfig) {}

  private get baseUrl(): string {
    const url = this.config.baseUrl ?? DEFAULT_BASE_URL[this.config.kind] ?? DEFAULT_BASE_URL['openai-compatible']!;
    return url.replace(/\/+$/, '');
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.config.headers ?? {}),
    };
    const key = this.resolveKey();
    if (key) headers.authorization = `Bearer ${key}`;
    return headers;
  }

  private resolveKey(): string | undefined {
    if (this.config.apiKey) return this.config.apiKey;
    if (this.config.apiKeyEnv) {
      const fromEnv = process.env[this.config.apiKeyEnv];
      if (fromEnv) return fromEnv;
    }
    return undefined;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildBody(request);
    const res = await withRetry(async () => {
      const response = await httpRequest({
        url: `${this.baseUrl}/chat/completions`,
        method: 'POST',
        headers: this.buildHeaders(),
        body,
        signal: request.signal,
      });
      if (!response.ok) {
        const detail = this.extractError(response.text);
        throw new ProviderError(
          this.config.id,
          `${this.config.label} (${this.config.model}) request failed [${response.status}]: ${detail}`,
          { status: response.status, retryable: response.status === 429 || response.status >= 500 },
        );
      }
      return response;
    });

    const payload = res.json<OpenAiResponse>();
    if (payload.error) {
      throw new ProviderError(this.config.id, payload.error.message ?? 'Unknown provider error', {
        retryable: true,
      });
    }

    const choice = payload.choices?.[0];
    const rawMessage = choice?.message;
    const toolCalls: ToolCall[] = (rawMessage?.tool_calls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc, index) => ({
        id: tc.id ?? `call_${index}`,
        name: tc.function!.name!,
        arguments: parseArguments(tc.function?.arguments),
      }));

    const content = rawMessage?.content ?? '';
    const message: ChatMessage = {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return {
      message,
      toolCalls,
      finishReason: choice?.finish_reason,
      usage: payload.usage
        ? {
            promptTokens: payload.usage.prompt_tokens,
            completionTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
          }
        : undefined,
      providerId: this.config.id,
      model: this.config.model,
    };
  }

  private buildBody(request: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toOpenAiMessages(request.messages),
      stream: false,
    };

    const temperature = request.temperature ?? this.config.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    const maxTokens = request.maxTokens ?? this.config.maxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    const tools = request.tools ?? [];
    const supportsTools = this.config.supportsTools ?? true;
    if (tools.length > 0 && supportsTools) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: toJsonSchema(t.parameters),
        },
      }));
      if (request.toolChoice) body.tool_choice = request.toolChoice;
    }

    if (this.config.extraBody) Object.assign(body, this.config.extraBody);
    if (request.extraBody) Object.assign(body, request.extraBody);

    return body;
  }

  private extractError(text: string): string {
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      /* not JSON */
    }
    return text.slice(0, 300);
  }

  async health(signal?: AbortSignal) {
    const started = Date.now();
    try {
      await httpRequest({
        url: `${this.baseUrl}/models`,
        method: 'GET',
        headers: this.buildHeaders(),
        signal,
        timeoutMs: 10_000,
      });
      return { id: this.config.id, reachable: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        id: this.config.id,
        reachable: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { __raw: raw };
  }
}

/** Converts Celeste messages into the OpenAI wire format. */
export function toOpenAiMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId ?? '',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const assistant: Record<string, unknown> = {
        role: 'assistant',
        content: typeof msg.content === 'string' ? msg.content : flattenText(msg.content),
      };
      assistant.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
      out.push(assistant);
      continue;
    }

    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Multimodal content parts.
    const parts = (msg.content ?? []).map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } };
    });
    out.push({ role: msg.role, content: parts });
  }

  return out;
}

function flattenText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n');
}
