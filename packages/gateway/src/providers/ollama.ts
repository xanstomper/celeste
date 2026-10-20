import type { ChatMessage, ToolCall } from '@celeste/protocol';
import { httpRequest, withRetry } from '../http.js';
import { ProviderError, toJsonSchema } from '../types.js';
import type { ChatRequest, ChatResponse, ModelProvider, ProviderConfig } from '../types.js';

interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}

interface OllamaResponse {
  message?: { role?: string; content?: string; tool_calls?: OllamaToolCall[] };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/**
 * Adapter for a local Ollama server. Ollama's `/api/chat` accepts an
 * OpenAI-ish message array plus a `tools` array, but keeps content as a plain
 * string, so multimodal parts are flattened.
 */
export class OllamaProvider implements ModelProvider {
  constructor(readonly config: ProviderConfig) {}

  private get baseUrl(): string {
    return (this.config.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toOllamaMessages(request.messages),
      stream: false,
    };

    const temperature = request.temperature ?? this.config.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    const maxTokens = request.maxTokens ?? this.config.maxTokens;
    if (maxTokens !== undefined) body.options = { num_predict: maxTokens };

    const tools = request.tools ?? [];
    if (tools.length > 0 && (this.config.supportsTools ?? true)) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: toJsonSchema(t.parameters),
        },
      }));
    }

    if (this.config.extraBody) Object.assign(body, this.config.extraBody);
    if (request.extraBody) Object.assign(body, request.extraBody);

    const res = await withRetry(async () => {
      const response = await httpRequest({
        url: `${this.baseUrl}/api/chat`,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.config.headers ?? {}) },
        body,
        signal: request.signal,
        timeoutMs: 600_000,
      });
      if (!response.ok) {
        throw new ProviderError(
          this.config.id,
          `Ollama request failed [${response.status}]: ${response.text.slice(0, 300)}`,
          { status: response.status, retryable: response.status >= 500 },
        );
      }
      return response;
    });

    const payload = res.json<OllamaResponse>();
    if (payload.error) {
      throw new ProviderError(this.config.id, payload.error, { retryable: true });
    }

    const toolCalls: ToolCall[] = (payload.message?.tool_calls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc, i) => ({
        id: `call_${i}`,
        name: tc.function!.name!,
        arguments:
          tc.function!.arguments && typeof tc.function!.arguments === 'object'
            ? (tc.function!.arguments as Record<string, unknown>)
            : {},
      }));

    const content = payload.message?.content ?? '';
    const message: ChatMessage = {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return {
      message,
      toolCalls,
      finishReason: payload.done_reason,
      usage: {
        promptTokens: payload.prompt_eval_count,
        completionTokens: payload.eval_count,
        totalTokens: (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0),
      },
      providerId: this.config.id,
      model: this.config.model,
    };
  }

  async health(signal?: AbortSignal) {
    const started = Date.now();
    try {
      const res = await httpRequest({
        url: `${this.baseUrl}/api/tags`,
        method: 'GET',
        signal,
        timeoutMs: 5000,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
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

function toOllamaMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      return { role: 'tool', content: typeof msg.content === 'string' ? msg.content : '' };
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      return {
        role: 'assistant',
        content: typeof msg.content === 'string' ? msg.content : '',
        tool_calls: msg.toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return {
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : flattenText(msg.content),
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
