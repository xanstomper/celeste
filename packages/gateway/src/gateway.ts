import { AnthropicProvider } from './providers/anthropic.js';
import { GoogleProvider } from './providers/google.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAiCompatibleProvider } from './providers/openai.js';
import { ProviderError } from './types.js';
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ProviderConfig,
  ProviderHealth,
  ProviderKind,
} from './types.js';

export interface GatewayOptions {
  /** Called whenever the active provider changes. */
  onProviderChange?: (provider: ProviderConfig) => void;
}

/**
 * Whether a provider has enough configuration to be worth trying.
 *
 * An unconfigured cloud provider fails before it reaches the network, and its
 * error can mask the real reason the preferred provider did not answer.
 */
function isConfigured(config: ProviderConfig): boolean {
  if (config.apiKey) return true;
  if (config.apiKeyEnv && process.env[config.apiKeyEnv]) return true;
  if (config.kind === 'ollama') return true;
  const url = config.baseUrl ?? '';
  return url.includes('localhost') || url.includes('127.0.0.1') || url.includes('pollinations');
}

/**
 * The Universal Model Gateway.
 *
 * Every provider is created lazily and cached. Switching the active model is
 * a single assignment — no reload, no restart, no vendor lock-in.
 */
export class ModelGateway {
  private providers = new Map<string, ModelProvider>();
  private configById = new Map<string, ProviderConfig>();
  private activeId: string | undefined;

  constructor(
    private providerConfigs: ProviderConfig[] = [],
    private options: GatewayOptions = {},
  ) {
    for (const cfg of providerConfigs) this.configById.set(cfg.id, cfg);
  }

  /** Replaces the provider catalogue (e.g. after a config reload). */
  setProviders(configs: ProviderConfig[]): void {
    this.providers.clear();
    this.configById.clear();
    for (const cfg of configs) this.configById.set(cfg.id, cfg);
    if (this.activeId && !this.configById.has(this.activeId)) {
      this.activeId = undefined;
    }
  }

  listProviders(): ProviderConfig[] {
    return [...this.configById.values()];
  }

  getActiveId(): string | undefined {
    return this.activeId;
  }

  /** Switches the active model. Throws when the id is unknown. */
  setActiveProvider(id: string): ProviderConfig {
    const cfg = this.configById.get(id);
    if (!cfg) {
      throw new ProviderError(id, `Unknown provider "${id}". Known: ${[...this.configById.keys()].join(', ')}`);
    }
    this.activeId = id;
    this.options.onProviderChange?.(cfg);
    return cfg;
  }

  /** Resolves a provider by id, creating the adapter on first use. */
  getProvider(id?: string): ModelProvider {
    const target = id ?? this.activeId;
    if (!target) {
      throw new ProviderError('gateway', 'No active provider configured');
    }
    const cached = this.providers.get(target);
    if (cached) return cached;

    const cfg = this.configById.get(target);
    if (!cfg) {
      throw new ProviderError(target, `Unknown provider "${target}"`);
    }
    const provider = createProvider(cfg);
    this.providers.set(target, provider);
    return provider;
  }

  /**
   * Sends a chat completion through the active provider.
   *
   * Free providers run out of quota, rate-limit, and go down. When the
   * preferred provider fails with something retryable, the gateway tries the
   * others rather than failing the task outright: the user wants an answer,
   * not a particular vendor.
   */
  async chat(request: ChatRequest, providerId?: string): Promise<ChatResponse> {
    const primary = this.getProvider(providerId);

    // Once a provider has streamed part of an answer to the screen, falling
    // back to another provider would repeat it. At that point the failure is
    // final: a half-written answer is better than two overlapping ones.
    let streamed = false;
    const tracked: ChatRequest = request.onDelta
      ? {
          ...request,
          onDelta: (delta) => {
            streamed = true;
            request.onDelta?.(delta);
          },
        }
      : request;

    // Free tiers enforce concurrency, not just rate: two tasks at once and
    // every request comes back 429. That is transient, so ride it out for a
    // few seconds before telling the reader to try again.
    const deadline = Date.now() + 30_000;
    let wait = 4_000;

    for (;;) {
      const errors: unknown[] = [];

      try {
        return await primary.chat(tracked);
      } catch (err) {
        const malformed =
          err instanceof ProviderError && (err.status === 400 || err.status === 422);
        if (malformed || streamed || request.signal?.aborted) throw err;
        errors.push(err);
      }

      const alternatives = this.listProviders().filter(
        (cfg) => cfg.id !== primary.config.id && isConfigured(cfg),
      );
      for (const cfg of alternatives) {
        if (request.signal?.aborted) throw errors.at(-1);
        try {
          return await this.getProvider(cfg.id).chat(tracked);
        } catch (next) {
          const malformed =
            next instanceof ProviderError && (next.status === 400 || next.status === 422);
          if (malformed || streamed) throw next;
          errors.push(next);
        }
      }

      const allBusy =
        errors.length > 0 &&
        errors.every((error) => error instanceof ProviderError && error.status === 429);

      if (allBusy && Date.now() < deadline && !request.signal?.aborted) {
        await delay(wait, request.signal);
        wait = Math.min(wait * 2, 10_000);
        continue;
      }

      if (allBusy) {
        throw new ProviderError(
          'gateway',
          'Every free provider is at its concurrency limit right now. Nothing was lost — try again in a few seconds.',
          { status: 429, retryable: true },
        );
      }

      const reasons = [
        ...new Set(
          errors.map((error) => (error instanceof Error ? error.message : String(error))),
        ),
      ];
      throw new ProviderError(
        'gateway',
        reasons.length > 1
          ? `No provider could answer. ${reasons.slice(0, 3).join(' | ')}`
          : (reasons[0] ?? 'No provider could answer.'),
        { status: 503, retryable: true },
      );
    }
  }

  /** Probes every configured provider concurrently. */
  async healthAll(signal?: AbortSignal): Promise<ProviderHealth[]> {
    const results = await Promise.all(
      this.listProviders().map(async (cfg): Promise<ProviderHealth> => {
        try {
          const provider = this.getProvider(cfg.id);
          if (provider.health) return await provider.health(signal);
          return { id: cfg.id, reachable: true };
        } catch (err) {
          return {
            id: cfg.id,
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return results;
  }
}

/** Creates the adapter matching a provider's declared kind. */
export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'google':
      return new GoogleProvider(config);
    case 'openai':
    case 'openai-compatible':
    case 'custom':
    default:
      return new OpenAiCompatibleProvider(config);
  }
}

/** Maps a loose provider-kind string (e.g. from the UI) to a typed kind. */
export function normaliseProviderKind(input: string): ProviderKind {
  const value = input.toLowerCase().trim();
  switch (value) {
    case 'anthropic':
    case 'claude':
      return 'anthropic';
    case 'ollama':
      return 'ollama';
    case 'google':
    case 'gemini':
      return 'google';
    case 'openai':
      return 'openai';
    case 'custom':
      return 'custom';
    default:
      return 'openai-compatible';
  }
}

/** Waits, but wakes up immediately when the task is cancelled. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderError('gateway', 'Cancelled', { status: 499, retryable: false }));
      },
      { once: true },
    );
  });
}
