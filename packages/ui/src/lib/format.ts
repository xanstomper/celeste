/** Small formatting helpers shared across the UI. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const delta = now - timestamp;
  if (delta < 0) return 'just now';
  if (delta < 5_000) return 'just now';
  if (delta < MINUTE) return `${Math.round(delta / 1000)}s ago`;
  if (delta < HOUR) return `${Math.round(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.round(delta / HOUR)}h ago`;
  if (delta < 7 * DAY) return `${Math.round(delta / DAY)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Turns `browser_navigate` into `Browser navigate`. */
export function humanizeToolName(name: string): string {
  const cleaned = name.replace(/[_-]+/g, ' ').trim();
  if (!cleaned) return name;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** The host of a URL, without the `www.` prefix. */
export function hostOf(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./i, '');
  } catch {
    return trimmed.replace(/^https?:\/\//i, '').split('/')[0] ?? '';
  }
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The short, human phrase a tool call is shown as.
 *
 * Perplexity shows what the agent is *doing* ("Reading example.com"), not the
 * name of the function it called. This is the same idea, derived from the
 * tool's arguments.
 */
export function toolLabel(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const url = argString(args, 'url') ?? argString(args, 'href');
  const domain = url ? hostOf(url) : '';
  const label = argString(args, 'label') ?? argString(args, 'text') ?? argString(args, 'query');
  const selector = argString(args, 'selector');
  const ref = argString(args, 'ref');

  switch (toolName) {
    case 'browser_navigate':
      return domain ? `Opening ${domain}` : 'Opening a page';
    case 'browser_extract':
      return domain ? `Reading ${domain}` : 'Reading the page';
    case 'browser_snapshot':
      return domain ? `Reading ${domain}` : 'Reading the page';
    case 'browser_click':
      return label ? `Clicking ${label}` : ref ? `Clicking ${ref}` : 'Clicking an element';
    case 'browser_type':
      return ref ? `Typing into ${ref}` : 'Typing';
    case 'browser_submit_form':
      return selector ? `Submitting ${selector}` : 'Submitting a form';
    case 'browser_scroll':
      return 'Scrolling the page';
    case 'browser_screenshot':
      return 'Taking a screenshot';
    case 'web_search':
      return label ? `Searching for ${label}` : 'Searching the web';
    default:
      return humanizeToolName(toolName);
  }
}

/**
 * Model names, written the way a person would say them.
 *
 * `glm-5.3-flash` becomes `GLM-5.3-Flash` — the raw id is useful in logs,
 * but a header chip should read like a product name.
 */
const MODEL_ACRONYMS: Record<string, string> = {
  ai: 'AI',
  atria: 'Atria',
  chat: 'Chat',
  claude: 'Claude',
  code: 'Code',
  deepseek: 'DeepSeek',
  diffusiongemma: 'DiffusionGemma',
  flash: 'Flash',
  free: 'Free',
  gemma: 'Gemma',
  glm: 'GLM',
  gpt: 'GPT',
  llama: 'Llama',
  llm: 'LLM',
  luna: 'Luna',
  minimax: 'MiniMax',
  openai: 'OpenAI',
  preview: 'Preview',
  pro: 'Pro',
  qwen: 'Qwen',
  sonnet: 'Sonnet',
  sr: 'SR',
  turbo: 'Turbo',
};

export function modelName(model: string): string {
  if (!model) return model;
  return model
    .split('-')
    .map((part) => {
      if (!part) return part;
      const key = part.toLowerCase();
      if (MODEL_ACRONYMS[key]) return MODEL_ACRONYMS[key]!;
      // Version-ish parts keep their shape: 5.3, 35B, v4, 2.
      const version = /^(\d[\d.]*)([a-z])$/.exec(part);
      if (version) return `${version[1]}${version[2]!.toUpperCase()}`;
      if (/^\d/.test(part) || /^v\d/.test(part)) return part;
      return part[0]!.toUpperCase() + part.slice(1);
    })
    .join('-');
}
