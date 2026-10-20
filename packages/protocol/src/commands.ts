import type { ProtocolErrorShape } from './errors.js';

export interface BrowserCommand {
  /** Command verb, e.g. `navigate`, `click`, `snapshot`. */
  action: string;
  /** Verb-specific arguments. */
  params?: Record<string, unknown>;
  /** Target tab; omit or -1 for the active tab. */
  tabId?: number;
  /** How long the extension should wait before giving up (ms). */
  timeoutMs?: number;
}

export interface BrowserCommandEnvelope {
  v: string;
  type: 'browser.command';
  id: string;
  payload: BrowserCommand;
}

export interface BrowserResultEnvelope {
  v: string;
  type: 'browser.result';
  id: string;
  payload:
    | { ok: true; result: unknown }
    | { ok: false; error: ProtocolErrorShape };
}

/** Discriminated union of every browser verb the extension understands. */
export interface BrowserCommandMap {
  navigate: { url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' };
  back: Record<string, never>;
  forward: Record<string, never>;
  reload: Record<string, never>;
  snapshot: { maxElements?: number; includeText?: boolean };
  click: { ref?: string; x?: number; y?: number; button?: 'left' | 'right' | 'middle' };
  type: { ref: string; text: string; clear?: boolean; delayMs?: number };
  fill: { ref: string; value: string };
  press: { ref?: string; key: string; modifiers?: ('Control' | 'Alt' | 'Shift' | 'Meta')[] };
  scroll: { direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; ref?: string };
  hover: { ref: string };
  select: { ref: string; value: string };
  focus: { ref: string };
  blur: Record<string, never>;
  tabs: { action?: 'list' | 'create' | 'close' | 'activate'; url?: string; tabId?: number };
  evaluate: { expression: string };
  extract: { selector?: string };
  screenshot: { fullPage?: boolean; format?: 'png' | 'jpeg' };
  getText: { selector?: string };
  network: { action: 'list' | 'clear'; filter?: string };
  cookies: { action: 'get' | 'set' | 'clear'; url?: string; name?: string; value?: string };
  waitFor: { selector?: string; text?: string; timeoutMs?: number };
  challenge: { action: 'detect' | 'report' };
  console: { action: 'list' | 'clear' };
  highlight: { ref: string };
  download: { action: 'list' | 'save'; path?: string };
}

export type BrowserAction = keyof BrowserCommandMap;

/** Every browser verb, listed, so the extension and daemon agree. */
export const BROWSER_ACTIONS: BrowserAction[] = [
  'navigate',
  'back',
  'forward',
  'reload',
  'snapshot',
  'click',
  'type',
  'fill',
  'press',
  'scroll',
  'hover',
  'select',
  'focus',
  'blur',
  'tabs',
  'evaluate',
  'extract',
  'screenshot',
  'getText',
  'network',
  'cookies',
  'waitFor',
  'challenge',
  'console',
  'highlight',
  'download',
];
