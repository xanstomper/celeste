import type { ChatMessage, ToolCall } from '@celeste/protocol';
import { httpRequest, withRetry } from '../http.js';
import { ProviderError, toJsonSchema } from '../types.js';
import type { ChatRequest, ChatResponse, ModelProvider, ProviderConfig } from '../types.js';

interface AnthropicToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  source?: { type?: string; data?: string; media_type?: string };
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Adapter for Anthropic's Messages API (Claude family).
 */
export class AnthropicProvider implements ModelProvider {
  constructor(readonly config: ProviderConfig) {}

  private get baseUrl(): string {
    return (this.config.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  }

  private resolveKey(): string | undefined {
    if (this.config.apiKey) return this.config.apiKey;
    if (this.config.apiKeyEnv) return process.env[this.config.apiKeyEnv];
    return undefined;
  }

  private headers(): Record<string, string> {
    const key = this.resolveKey();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(this.config.headers ?? {}),
    };
    if (key) headers['x-api-key'] = key;
    return headers;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildBody(request);

    const res = await withRetry(async () => {
      const response = await httpRequest({
        url: `${this.baseUrl}/v1/messages`,
        method: 'POST',
        headers: this.headers(),
        body,
        signal: request.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new ProviderError(
          this.config.id,
          `${this.config.label} request failed [${response.status}]: ${response.text.slice(0, 300)}`,
          { status: response.status, retryable },
        );
      }
      return response;
    });

    const payload = res.json<AnthropicResponse>();
    if (payload.error) {
      throw new ProviderError(this.config.id, payload.error.message ?? 'Anthropic error');
    }

    const blocks = payload.content ?? [];
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const thinking = blocks
      .filter((b) => b.type === 'thinking')
      .map((b) => b.thinking ?? '')
      .join('');

    const toolCalls: ToolCall[] = blocks
      .filter((b): b is AnthropicContentBlock & { type: 'tool_use' } => b.type === 'tool_use')
      .map((b) => ({
        id: b.id ?? 'tool_use',
        name: b.name ?? 'unknown',
        arguments:
          b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {},
      }));

    const message: ChatMessage = {
      role: 'assistant',
      content: [thinking, text].filter(Boolean).join('\n\n'),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return {
      message,
      toolCalls,
      finishReason: payload.stop_reason,
      usage: payload.usage
        ? {
            promptTokens: payload.usage.input_tokens,
            completionTokens: payload.usage.output_tokens,
            totalTokens: (payload.usage.input_tokens ?? 0) + (payload.usage.output_tokens ?? 0),
          }
        : undefined,
      providerId: this.config.id,
      model: this.config.model,
    };
  }

  private buildBody(request: ChatRequest): Record<string, unknown> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : flattenText(m.content)))
      .join('\n\n');

    const messages: unknown[] = [];
    for (const msg of request.messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'assistant') {
        const blocks: unknown[] = [];
        const text = typeof msg.content === 'string' ? msg.content : flattenText(msg.content);
        if (text) blocks.push({ type: 'text', text });
        for (const tc of msg.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
        if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
        continue;
      }

      if (msg.role === 'tool') {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId ?? '',
              content: typeof msg.content === 'string' ? msg.content : flattenText(msg.content),
            },
          ],
        });
        continue;
      }

      messages.push({ role: 'user', content: toAnthropicContent(msg.content) });
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
    };
    if (system) body.system = system;

    const temperature = request.temperature ?? this.config.temperature;
    if (temperature !== undefined) body.temperature = temperature;

    const tools = request.tools ?? [];
    if (tools.length > 0 && (this.config.supportsTools ?? true)) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: toJsonSchema(t.parameters),
      }));
    }

    if (this.config.extraBody) Object.assign(body, this.config.extraBody);
    if (request.extraBody) Object.assign(body, request.extraBody);
    return body;
  }
}

function toAnthropicContent(content: ChatMessage['content']): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    return {
      type: 'image',
      source: { type: 'base64', media_type: part.mimeType, data: part.data },
    };
  });
}

function flattenText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n');
}
