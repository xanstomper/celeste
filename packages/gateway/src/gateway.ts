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

  /** Sends a chat completion through the active provider. */
  async chat(request: ChatRequest, providerId?: string): Promise<ChatResponse> {
    return this.getProvider(providerId).chat(request);
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
