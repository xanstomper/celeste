import type { ChatMessage, ToolCall, ToolDefinition } from '@celeste/protocol';
import { httpRequest, httpStream, withRetry } from '../http.js';
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

/**
 * Reads a "retry after Ns" hint out of an error body.
 *
 * Free tiers word this differently — "Retry after 14s", "try again in 30
 * seconds" — and only the number matters. Returns milliseconds, or undefined
 * when there is no usable hint (or it asks for an unreasonable wait).
 */
export function parseRetryAfter(detail: string): number | undefined {
  const match = /(?:retry|try again)\s*(?:after|in)?\s*(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?|mins?|minutes?)?/i.exec(
    detail,
  );
  if (!match) return undefined;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const unit = (match[2] ?? 's').toLowerCase();
  const seconds = unit === 'ms' ? value / 1000 : unit.startsWith('m') ? value * 60 : value;
  const ms = Math.round(seconds * 1000);

  return ms > 0 && ms <= 120_000 ? ms : undefined;
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
    // Some free routers hang on SSE; a plain response is slower to appear but
    // it actually arrives.
    if (request.onDelta && this.config.stream !== false) return this.chatStreaming(request);

    const body = this.buildBody(request);
    // One retry, not three: the gateway falls back to another provider, which
    // is a better recovery than hammering a provider that is not answering.
    const res = await withRetry(async () => {
      const response = await httpRequest({
        url: `${this.baseUrl}/chat/completions`,
        method: 'POST',
        headers: this.buildHeaders(),
        body,
        signal: request.signal,
        timeoutMs: this.config.timeoutMs ?? 90_000,
      });
      if (!response.ok) {
        const detail = this.extractError(response.text);

        // "Retry after 14s" is an instruction, not a refusal. Free tiers use
        // it constantly; waiting once is far better than failing the task.
        const retryAfterMs = parseRetryAfter(detail);
        const rateLimited = response.status === 402 || response.status === 429;
        throw new ProviderError(
          this.config.id,
          `${this.config.label} (${this.config.model}) request failed [${response.status}]: ${detail}`,
          {
            status: response.status,
            retryable:
              response.status >= 500 ||
              response.status === 429 ||
              (rateLimited && retryAfterMs !== undefined),
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          },
        );
      }
      return response;
    }, { attempts: 2, baseDelayMs: 800, signal: request.signal });

    return this.normalise(res.json<OpenAiResponse>());
  }

  /** Turns an OpenAI-shaped payload into Celeste's normalised response. */
  private normalise(payload: OpenAiResponse): ChatResponse {
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

  /**
   * Streams a completion, calling `request.onDelta` for each fragment.
   *
   * The assembled message is still returned in full, so the agent stores and
   * renders exactly what a non-streaming call would have produced. A server
   * that ignores `stream: true` is detected and parsed the normal way.
   */
  private async chatStreaming(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = { ...this.buildBody(request), stream: true };
    let content = '';
    let finishReason: string | undefined;
    let usage: OpenAiResponse['usage'];
    const calls = new Map<number, { id?: string; name?: string; arguments: string }>();

    const res = await httpStream({
      url: `${this.baseUrl}/chat/completions`,
      method: 'POST',
      headers: this.buildHeaders(),
      body,
      signal: request.signal,
      timeoutMs: this.config.timeoutMs ?? 120_000,
      onData: (data) => {
        if (data === '[DONE]') return;

        interface StreamEvent {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string;
          }>;
          usage?: OpenAiResponse['usage'];
        }

        let event: StreamEvent;
        try {
          event = JSON.parse(data) as StreamEvent;
        } catch {
          return;
        }

        if (event.usage) usage = event.usage;
        const choice = event.choices?.[0];
        if (!choice) return;

        const delta = choice.delta;
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          content += delta.content;
          request.onDelta?.(delta.content);
        }

        for (const tc of delta?.tool_calls ?? []) {
          const index = typeof tc.index === 'number' ? tc.index : 0;
          const entry = calls.get(index) ?? { arguments: '' };
          if (typeof tc.id === 'string') entry.id = tc.id;
          if (typeof tc.function?.name === 'string') entry.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') entry.arguments += tc.function.arguments;
          calls.set(index, entry);
        }

        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      },
    });

    if (!res.ok) {
      const detail = this.extractError(res.text);
      const concurrency = /concurrency_limit|too many concurrent/i.test(detail);
      const retryAfterMs = parseRetryAfter(detail) ?? (concurrency ? 4_000 : undefined);
      const rateLimited = res.status === 402 || res.status === 429;
      throw new ProviderError(
        this.config.id,
        `${this.config.label} (${this.config.model}) request failed [${res.status}]: ${detail}`,
        {
          status: res.status,
          retryable:
            res.status >= 500 || res.status === 429 || (rateLimited && retryAfterMs !== undefined),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
    }

    // Nothing was streamed and the body looks like JSON: the server ignored
    // `stream: true`.
    if (content.length === 0 && calls.size === 0 && res.text.trim().startsWith('{')) {
      return this.normalise(res.json<OpenAiResponse>());
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, call]) => Boolean(call.name))
      .map(([index, call]) => ({
        id: call.id ?? `call_${index}`,
        name: call.name!,
        arguments: parseArguments(call.arguments),
      }));

    return {
      message: {
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      toolCalls,
      finishReason,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
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
