/**
 * Trusted browser input.
 *
 * Canvas editors - Google Docs, Sheets, Figma, Excalidraw - paint their
 * surface on a <canvas> and listen for *real* input. A synthetic
 * `KeyboardEvent` dispatched from a content script is untrusted, and those
 * editors ignore it completely: the cursor blinks, nothing is typed.
 *
 * Chrome's debugger protocol lets us insert text the way a person does. The
 * browser itself produces the event, so every editor - canvas or DOM - accepts
 * it. That is the difference between "the agent says it typed" and "the text
 * is in the document".
 *
 * The debugger is attached only while a command is running and released
 * afterwards, so the yellow "this extension is debugging your browser" banner
 * does not linger.
 */

const DEBUGGER_VERSION = '1.3';

let attachedTabId: number | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

/** How long the debugger may stay attached without a command. */
const IDLE_RELEASE_MS = 30_000;

function hasDebugger(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.debugger;
}

/** Whether the extension may attach a debugger at all. */
export function debuggerAvailable(): boolean {
  return hasDebugger();
}

function scheduleRelease(delayMs: number = IDLE_RELEASE_MS): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    void releaseDebugger();
  }, delayMs);
}

/** Detaches from the tab, if attached. Safe to call at any time. */
export async function releaseDebugger(): Promise<void> {
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  const tabId = attachedTabId;
  attachedTabId = null;
  if (tabId === null || !hasDebugger()) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* the tab is gone, or Chrome already detached us */
  }
}

async function attach(tabId: number): Promise<void> {
  if (!hasDebugger()) throw new Error('The debugger API is not available.');
  if (attachedTabId === tabId) {
    scheduleRelease();
    return;
  }
  await releaseDebugger();
  await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  attachedTabId = tabId;
  scheduleRelease();
}

async function send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const tabId = attachedTabId;
  if (tabId === null) throw new Error('Not attached to a tab.');
  const result = await chrome.debugger.sendCommand({ tabId }, method, params);
  scheduleRelease();
  return result as T;
}

/**
 * Inserts text into whatever currently has focus.
 *
 * The text arrives as one insertion, exactly like a paste - which is how
 * people actually put long text into a document, and how every editor
 * expects it.
 */
export async function insertText(tabId: number, text: string): Promise<void> {
  await attach(tabId);
  await send('Input.insertText', { text });
}

/**
 * A real click at viewport coordinates.
 *
 * Unlike a synthetic click this moves the browser's focus into the page,
 * which is what makes the following `insertText` land in the right place.
 */
export async function clickAt(tabId: number, x: number, y: number): Promise<void> {
  await attach(tabId);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
    buttons: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
    buttons: 0,
  });
}

interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const KEYS: Record<string, KeySpec> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

function modifierMask(modifiers: string[]): number {
  let mask = 0;
  for (const modifier of modifiers) {
    switch (modifier.toLowerCase()) {
      case 'alt':
        mask |= 1;
        break;
      case 'ctrl':
        mask |= 2;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
        mask |= 4;
        break;
      case 'shift':
        mask |= 8;
        break;
      default:
        break;
    }
  }
  return mask;
}

/** Presses a named key, with optional modifiers. */
export async function pressKey(
  tabId: number,
  key: string,
  modifiers: string[] = [],
): Promise<void> {
  await attach(tabId);
  const spec = KEYS[key] ?? { key, code: key, keyCode: 0 };
  const modifiersMask = modifierMask(modifiers);
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers: modifiersMask,
  };
  await send('Input.dispatchKeyEvent', {
    ...base,
    type: spec.text ? 'keyDown' : 'rawKeyDown',
    ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}),
  });
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

/** Scrolls the page with real wheel events. */
export async function scrollBy(tabId: number, deltaY: number, deltaX = 0): Promise<void> {
  await attach(tabId);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 10,
    y: 10,
    deltaX,
    deltaY,
  });
}

/** Whether the debugger is currently attached to a tab. */
export function isAttached(): boolean {
  return attachedTabId !== null;
}
