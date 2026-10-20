import type { ChatMessage, JsonSchema, ToolCall, ToolDefinition } from '@celeste/protocol';

/** The set of provider families the gateway can talk to. */
export type ProviderKind =
  | 'openai'
  | 'openai-compatible'
  | 'anthropic'
  | 'ollama'
  | 'google'
  | 'custom';

export interface ProviderConfig {
  /** Stable identifier used in config files and the UI, e.g. `openrouter`. */
  id: string;
  /** Which adapter handles this provider. */
  kind: ProviderKind;
  /** Human readable name. */
  label: string;
  /** API base URL. `null` means "use the provider default". */
  baseUrl?: string | null;
  /** Model identifier passed to the API. */
  model: string;
  /**
   * API key. Resolution order at runtime:
   *   1. explicit `apiKey` here
   *   2. environment variable named by `apiKeyEnv`
   *   3. unset (provider is then treated as local / unauthenticated)
   */
  apiKey?: string | null;
  /** Name of the environment variable holding the key. */
  apiKeyEnv?: string;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /**
   * How long a single request may take before it is abandoned, in ms.
   * Free providers can hang rather than fail, so this is what keeps a task
   * moving. Defaults to 90s.
   */
  timeoutMs?: number;
  /** Maximum tokens to request. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Whether the provider supports native tool calling. */
  supportsTools?: boolean;
  /** Whether the provider supports image parts. */
  supportsVision?: boolean;
  /** Requests per minute cap applied client-side. */
  rateLimitRpm?: number;
  /** Extra provider-specific fields merged into the request body. */
  extraBody?: Record<string, unknown>;
  /** Where this entry came from: `config` file or environment. */
  source?: 'config' | 'env' | 'builtin';
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Per-request override of the provider's JSON schema tool format. */
  toolChoice?: 'auto' | 'none' | 'required';
  /** Aborts the underlying HTTP request. */
  signal?: AbortSignal;
  /**
   * Called with each fragment of the answer as it is written.
   *
   * Providers that support streaming use it; the others simply never call
   * it and return the whole message at once. Callers must treat it as a
   * preview: the final `ChatResponse` is still the source of truth.
   */
  onDelta?: (delta: string) => void;
  /** Extra provider-specific body fields. */
  extraBody?: Record<string, unknown>;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  /** Normalised assistant message. */
  message: ChatMessage;
  /** Tool calls requested by the model. */
  toolCalls: ToolCall[];
  /** Provider-native finish reason. */
  finishReason?: string;
  usage?: ModelUsage;
  /** Which provider actually served the request. */
  providerId: string;
  model: string;
}

export interface ProviderHealth {
  id: string;
  reachable: boolean;
  /** Round-trip latency of the probe, ms. */
  latencyMs?: number;
  error?: string;
}

/** Adapter contract implemented by every provider family. */
export interface ModelProvider {
  readonly config: ProviderConfig;
  /** Performs a chat completion, normalising the result to the Celeste shape. */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Optional lightweight reachability probe. */
  health?(signal?: AbortSignal): Promise<ProviderHealth>;
}

/** Thrown when a provider call fails. */
export class ProviderError extends Error {
  readonly providerId: string;
  readonly status?: number;
  readonly retryable: boolean;
  /**
   * How long the provider asked us to wait, when it said so.
   *
   * Free tiers answer 402/429 with "Retry after 14s". Honouring that is the
   * difference between a task that completes slowly and one that fails.
   */
  readonly retryAfterMs?: number;

  constructor(
    providerId: string,
    message: string,
    options: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ProviderError';
    this.providerId = providerId;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Normalises the various JSON-schema dialects into Celeste's subset. */
export function toJsonSchema(schema: unknown): JsonSchema {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const raw = schema as Record<string, unknown>;
  const type =
    typeof raw.type === 'string' ? (raw.type as JsonSchema['type']) : 'object';
  const out: JsonSchema = { type };
  if (typeof raw.description === 'string') out.description = raw.description;
  if (Array.isArray(raw.enum)) out.enum = raw.enum as (string | number | boolean)[];
  if (raw.default !== undefined) out.default = raw.default;
  if (raw.properties && typeof raw.properties === 'object') {
    const props: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(raw.properties as Record<string, unknown>)) {
      props[key] = toJsonSchema(value);
    }
    out.properties = props;
  }
  if (Array.isArray(raw.required)) {
    out.required = raw.required.filter((r): r is string => typeof r === 'string');
  }
  if (raw.items) out.items = toJsonSchema(raw.items);
  if (typeof raw.additionalProperties === 'boolean') {
    out.additionalProperties = raw.additionalProperties;
  }
  return out;
}
