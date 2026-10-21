import { promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ProviderConfig, ProviderKind } from './types.js';

export interface CelesteConfig {
  /** Id of the provider that should serve requests by default. */
  activeProvider?: string;
  /** Every configured provider. */
  providers: ProviderConfig[];
  /** Where generated files are written. */
  outputDir?: string;
  /** Root for task checkpoints / transcripts. */
  dataDir?: string;
  /** Seconds before a browser command is considered failed. */
  browserTimeoutMs?: number;
  /** Maximum agent loop iterations per task. */
  maxSteps?: number;
  /** Enable the extension transport listener. */
  bridgePort?: number;
  /**
   * Ask the model for follow-up questions after every answer.
   *
   * Off by default: it is a second model call for every single task, and
   * the user's inference quota is finite.
   */
  suggestions?: boolean;
  /** Extra providers discovered from the environment. */
  [key: string]: unknown;
}

export const DEFAULT_CONFIG_PATHS = [
  path.join(process.cwd(), 'celeste.config.json'),
  path.join(homedir(), '.celeste', 'config.json'),
];

/**
 * Env files that are loaded before the configuration is resolved, so provider
 * keys do not have to be exported in the shell that happens to launch the
 * daemon. Existing environment variables always win.
 */
export const DEFAULT_ENV_PATHS = [
  // Celeste owns this file. Reading another app's env (Hermes) pulled in
  // expired keys that then polluted the provider fallback chain.
  path.join(homedir(), '.celeste', '.env'),
  path.join(process.cwd(), '.env'),
];

/**
 * Loads `KEY=value` pairs from env files into `process.env`.
 * Values already present in the environment are never overwritten.
 */
export function loadEnvFiles(paths: string[] = DEFAULT_ENV_PATHS): string[] {
  const loaded: string[] = [];
  for (const file of paths) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1]!;
      let value = (match[2] ?? '').trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!value) continue;
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
      loaded.push(`${file}:${key}`);
    }
  }
  return loaded;
}

export const DEFAULT_OUTPUT_DIR = path.join(homedir(), 'Documents', 'Celeste');
export const DEFAULT_DATA_DIR = path.join(homedir(), '.celeste', 'data');
export const DEFAULT_BRIDGE_PORT = 9223;

/**
 * Providers that are always present, so a fresh install can talk to a local
 * Ollama with zero configuration.
 */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: 'ollama',
    kind: 'ollama',
    label: 'Ollama (local)',
    baseUrl: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    model: 'qwen2.5:7b',
    apiKeyEnv: 'OLLAMA_API_KEY',
    supportsTools: true,
    source: 'builtin',
  },
  {
    id: 'openai',
    kind: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5',
    apiKeyEnv: 'OPENAI_API_KEY',
    supportsTools: true,
    supportsVision: true,
    source: 'builtin',
  },
  {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-4-1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    supportsTools: true,
    supportsVision: true,
    source: 'builtin',
  },
  {
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4.5',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    supportsTools: true,
    supportsVision: true,
    source: 'builtin',
  },
  {
    id: 'google',
    kind: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    apiKeyEnv: 'GEMINI_API_KEY',
    supportsTools: true,
    supportsVision: true,
    source: 'builtin',
  },
  {
    id: 'groq',
    kind: 'openai-compatible',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    apiKeyEnv: 'GROQ_API_KEY',
    supportsTools: true,
    source: 'builtin',
  },
  {
    id: 'lmstudio',
    kind: 'openai-compatible',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    apiKeyEnv: 'LMSTUDIO_API_KEY',
    supportsTools: true,
    source: 'builtin',
  },
  {
    id: 'llamacpp',
    kind: 'openai-compatible',
    label: 'llama.cpp server (local)',
    baseUrl: 'http://localhost:8080/v1',
    model: 'local-model',
    apiKeyEnv: 'LLAMACPP_API_KEY',
    supportsTools: true,
    source: 'builtin',
  },
];

function readJsonFile(file: string): CelesteConfig | null {
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as CelesteConfig;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Loads configuration from disk, merging in built-in providers and any
 * providers implied by environment variables.
 */
export async function loadConfig(explicitPath?: string): Promise<CelesteConfig> {
  loadEnvFiles();

  const candidates = explicitPath ? [explicitPath] : DEFAULT_CONFIG_PATHS;
  let fileConfig: CelesteConfig = { providers: [] };

  for (const candidate of candidates) {
    const loaded = readJsonFile(candidate);
    if (loaded) {
      fileConfig = loaded;
      break;
    }
  }

  const merged = new Map<string, ProviderConfig>();
  for (const provider of BUILTIN_PROVIDERS) {
    merged.set(provider.id, { ...provider });
  }
  for (const provider of fileConfig.providers ?? []) {
    const existing = merged.get(provider.id);
    merged.set(provider.id, { ...existing, ...provider, source: provider.source ?? 'config' });
  }
  for (const provider of discoverEnvProviders()) {
    if (!merged.has(provider.id)) merged.set(provider.id, provider);
  }

  const providers = [...merged.values()];

  return {
    ...fileConfig,
    providers,
    activeProvider: fileConfig.activeProvider ?? pickDefaultProvider(providers),
    outputDir: fileConfig.outputDir ?? DEFAULT_OUTPUT_DIR,
    dataDir: fileConfig.dataDir ?? DEFAULT_DATA_DIR,
    browserTimeoutMs: fileConfig.browserTimeoutMs ?? 30_000,
    maxSteps: fileConfig.maxSteps ?? 40,
    bridgePort: fileConfig.bridgePort ?? DEFAULT_BRIDGE_PORT,
  };
}

/** Creates provider entries for API keys present in the environment. */
export function discoverEnvProviders(): ProviderConfig[] {
  const found: ProviderConfig[] = [];
  const env = process.env;

  if (env.OLLAMA_HOST || env.OLLAMA_API_KEY) {
    found.push({
      id: 'ollama',
      kind: 'ollama',
      label: 'Ollama (local)',
      baseUrl: env.OLLAMA_HOST ?? 'http://localhost:11434',
      model: env.OLLAMA_MODEL ?? 'qwen2.5:7b',
      apiKeyEnv: 'OLLAMA_API_KEY',
      supportsTools: true,
      source: 'env',
    });
  }

  const openAiCompat: Array<[string, string, string, string]> = [
    ['OPENROUTER_API_KEY', 'openrouter', 'https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4.5'],
    ['GROQ_API_KEY', 'groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
    ['OPENAI_API_KEY', 'openai', 'https://api.openai.com/v1', 'gpt-5'],
    ['DEEPSEEK_API_KEY', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat'],
    ['TOGETHER_API_KEY', 'together', 'https://api.together.xyz/v1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    ['XAI_API_KEY', 'xai', 'https://api.x.ai/v1', 'grok-2-latest'],
    ['MOONSHOT_API_KEY', 'kimi', 'https://api.moonshot.ai/v1', 'moonshot-v1-32k'],
    ['SILICONFLOW_API_KEY', 'siliconflow', 'https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-V3'],
  ];

  for (const [envVar, id, baseUrl, model] of openAiCompat) {
    if (!env[envVar]) continue;
    found.push({
      id,
      kind: id === 'openai' ? 'openai' : 'openai-compatible',
      label: id,
      baseUrl,
      model,
      apiKeyEnv: envVar,
      supportsTools: true,
      source: 'env',
    });
  }

  if (env.ANTHROPIC_API_KEY) {
    found.push({
      id: 'anthropic',
      kind: 'anthropic',
      label: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: env.ANTHROPIC_MODEL ?? 'claude-opus-4-1',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      supportsTools: true,
      supportsVision: true,
      source: 'env',
    });
  }

  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
    found.push({
      id: 'google',
      kind: 'google',
      label: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: env.GEMINI_MODEL ?? 'gemini-2.0-flash',
      apiKeyEnv: env.GEMINI_API_KEY ?? 'GOOGLE_API_KEY',
      supportsTools: true,
      supportsVision: true,
      source: 'env',
    });
  }

  return found;
}

/** Prefers a local provider when one is configured, else the first entry. */
function pickDefaultProvider(providers: ProviderConfig[]): string | undefined {
  const local = providers.find(
    (p) => p.kind === 'ollama' && p.baseUrl && /localhost|127\.0\.0\.1/.test(p.baseUrl),
  );
  if (local) return local.id;
  return providers[0]?.id;
}

/** Writes the config back to disk, creating parent directories as needed. */
export async function saveConfig(config: CelesteConfig, targetPath?: string): Promise<string> {
  const file = targetPath ?? DEFAULT_CONFIG_PATHS[1]!;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}
