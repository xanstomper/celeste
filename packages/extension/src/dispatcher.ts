/**
 * Command dispatcher.
 *
 * Every verb in `BrowserCommandMap` is implemented here. The dispatcher is the
 * only place that knows *how* a command is realised (chrome API vs. content
 * script), which keeps `background.ts` focused on transport concerns.
 *
 * Rules:
 *  - DOM work goes through the content script (`chrome.tabs.sendMessage`,
 *    with a `chrome.scripting.executeScript` injection fallback).
 *  - Tab work goes through `chrome.tabs`.
 *  - Nothing throws raw exceptions across the boundary — every failure is
 *    converted into a `ProtocolErrorShape` by the caller.
 */

import { CelesteError, TimeoutError, createId } from './protocol.js';
import type { BrowserCommand, ElementRef, ProtocolErrorShape, TabInfo, ToolErrorCode } from './protocol.js';
import { CONTENT_CHANNEL } from './types.js';
import type { ContentResponse } from './types.js';
import { consoleLog, downloadLog, networkLog } from './state.js';
import type { ConsoleEntry, DownloadEntry } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const CONTENT_SCRIPT_FILE = 'content.js';
const PAGE_HOOK_FILE = 'page-hook.js';

/* -------------------------------------------------------------------------- */
/* Parameter helpers                                                          */
/* -------------------------------------------------------------------------- */

function str(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function bool(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function strList(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Tab helpers                                                                */
/* -------------------------------------------------------------------------- */

async function resolveTabId(tabId: number | undefined): Promise<number> {
  if (typeof tabId === 'number' && Number.isFinite(tabId) && tabId >= 0) {
    try {
      await chrome.tabs.get(tabId);
      return tabId;
    } catch {
      throw new CelesteError('NOT_FOUND', `Tab ${tabId} does not exist.`);
    }
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number') {
    throw new CelesteError('NOT_FOUND', 'No active tab to operate on.');
  }
  return tab.id;
}

function toTabInfo(tab: chrome.tabs.Tab): TabInfo {
  return {
    id: typeof tab.id === 'number' ? tab.id : -1,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: tab.active ?? false,
    ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Content script bridge                                                      */
/* -------------------------------------------------------------------------- */

function isMissingReceiver(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection') ||
    message.includes('message port closed')
  );
}

async function injectContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CelesteError(
      'PERMISSION_DENIED',
      `Cannot inject the Celeste content script into tab ${tabId}: ${message}`,
    );
  }
}

/** Ensures the content script is alive in the tab, injecting it if needed. */
export async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      channel: CONTENT_CHANNEL,
      id: createId('ping'),
      method: 'ping',
    } satisfies Record<string, unknown>);
    return;
  } catch (err) {
    if (!isMissingReceiver(err)) throw CelesteError.from(err, 'INTERNAL');
  }
  await injectContentScript(tabId);
}

/** Runs a method inside the page via the content script bridge. */
export async function callContent(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const request = {
    channel: CONTENT_CHANNEL,
    id: createId('cmd'),
    method,
    params,
  };

  let response: ContentResponse | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tabId, request)) as ContentResponse | undefined;
  } catch (err) {
    if (!isMissingReceiver(err)) throw CelesteError.from(err, 'INTERNAL');
    await injectContentScript(tabId);
    try {
      response = (await chrome.tabs.sendMessage(tabId, request)) as ContentResponse | undefined;
    } catch (retryErr) {
      throw CelesteError.from(retryErr, 'INTERNAL');
    }
  }

  if (!response) {
    throw new CelesteError('INTERNAL', `The content script did not answer "${method}".`);
  }
  if (!response.ok) {
    const shape: ProtocolErrorShape | undefined = response.error;
    throw new CelesteError((shape?.code ?? 'INTERNAL') as ToolErrorCode, shape?.message ?? 'Content script error', {
      retryable: shape?.retryable ?? false,
      ...(shape?.details !== undefined ? { details: shape.details } : {}),
    });
  }
  return response.result;
}

/* -------------------------------------------------------------------------- */
/* Navigation helpers                                                         */
/* -------------------------------------------------------------------------- */

type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';

async function waitForLoad(tabId: number, timeoutMs: number, waitUntil: WaitUntil): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  const alreadyComplete = async (): Promise<boolean> => {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab.status === 'complete';
    } catch {
      return false;
    }
  };

  if (await alreadyComplete()) {
    if (waitUntil !== 'networkidle') return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      clearInterval(poll);
      try {
        chrome.webNavigation.onDOMContentLoaded.removeListener(onDomContentLoaded);
        chrome.webNavigation.onCompleted.removeListener(onCompleted);
      } catch {
        /* ignore */
      }
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onDomContentLoaded = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      if (waitUntil === 'domcontentloaded') finish();
    };

    const onCompleted = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      finish();
    };

    chrome.webNavigation.onDOMContentLoaded.addListener(onDomContentLoaded);
    chrome.webNavigation.onCompleted.addListener(onCompleted);

    const timer = setTimeout(() => {
      fail(new TimeoutError(`Navigation to tab ${tabId} timed out after ${timeoutMs}ms.`, { waitUntil }));
    }, timeoutMs);

    const poll = setInterval(() => {
      void (async () => {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === 'complete') {
            if (waitUntil === 'networkidle') {
              // Give the page a short quiet period before declaring the
              // network idle.
              await new Promise((resolve) => setTimeout(resolve, 600));
            }
            finish();
          }
        } catch {
          fail(new CelesteError('NOT_FOUND', `Tab ${tabId} disappeared while navigating.`));
        }
      })();
    }, 250);
  });
}

function assertUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/^(https?|file|data|about|chrome|view-source):/i.test(parsed.protocol)) {
      throw new Error(`unsupported protocol "${parsed.protocol}"`);
    }
    return parsed.href;
  } catch (err) {
    throw new CelesteError('INVALID_ARGS', `Invalid url "${url}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Command implementations                                                    */
/* -------------------------------------------------------------------------- */

async function navigate(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const rawUrl = str(params, 'url');
  if (!rawUrl) throw new CelesteError('INVALID_ARGS', 'navigate requires a `url`.');
  const url = assertUrl(rawUrl);
  const waitUntil = (str(params, 'waitUntil') as WaitUntil | undefined) ?? 'load';
  const tabId = await resolveTabId(command.tabId);
  const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    await chrome.tabs.update(tabId, { url });
  } catch (err) {
    throw new CelesteError('NAVIGATION_FAILED', `Could not navigate to ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  await sleep(120);
  await waitForLoad(tabId, timeoutMs, waitUntil);

  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return {
    url: tab?.url ?? url,
    title: tab?.title ?? '',
    tabId,
  };
}

async function history(command: BrowserCommand, direction: 'back' | 'forward'): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const before = await chrome.tabs.get(tabId).catch(() => undefined);
  if (direction === 'back') await chrome.tabs.goBack(tabId);
  else await chrome.tabs.goForward(tabId);
  await sleep(120);
  await waitForLoad(tabId, command.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'load');
  const after = await chrome.tabs.get(tabId).catch(() => undefined);
  if (after && before && after.url === before.url) {
    throw new CelesteError('NAVIGATION_FAILED', `No ${direction} history for tab ${tabId}.`);
  }
  return { url: after?.url ?? '', title: after?.title ?? '', tabId };
}

async function reload(command: BrowserCommand): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  await chrome.tabs.reload(tabId);
  await sleep(120);
  await waitForLoad(tabId, command.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'load');
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return { url: tab?.url ?? '', title: tab?.title ?? '', tabId };
}

async function snapshot(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const result = await callContent(tabId, 'snapshot', {
    maxElements: num(params, 'maxElements'),
    includeText: bool(params, 'includeText'),
  });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function click(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const ref = str(params, 'ref');
  const x = num(params, 'x');
  const y = num(params, 'y');
  const button = (str(params, 'button') as 'left' | 'right' | 'middle' | undefined) ?? 'left';

  const result = (await callContent(tabId, 'click', { ref, x, y, button })) as Record<string, unknown>;
  return { tabId, ...result };
}

async function type(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const ref = str(params, 'ref');
  if (!ref) throw new CelesteError('INVALID_ARGS', 'type requires a `ref`.');
  const text = str(params, 'text') ?? '';
  const result = await callContent(tabId, 'type', {
    ref,
    text,
    clear: bool(params, 'clear'),
    delayMs: num(params, 'delayMs'),
  });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function fill(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const ref = str(params, 'ref');
  if (!ref) throw new CelesteError('INVALID_ARGS', 'fill requires a `ref`.');
  const value = str(params, 'value') ?? '';
  const result = await callContent(tabId, 'fill', { ref, value });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function press(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const key = str(params, 'key');
  if (!key) throw new CelesteError('INVALID_ARGS', 'press requires a `key`.');
  const result = await callContent(tabId, 'press', {
    key,
    ref: str(params, 'ref'),
    modifiers: strList(params, 'modifiers'),
  });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function scroll(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const result = await callContent(tabId, 'scroll', {
    direction: str(params, 'direction'),
    amount: num(params, 'amount'),
    ref: str(params, 'ref'),
  });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function hover(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const ref = str(params, 'ref');
  if (!ref) throw new CelesteError('INVALID_ARGS', 'hover requires a `ref`.');
  const result = await callContent(tabId, 'hover', { ref });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function select(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const ref = str(params, 'ref');
  if (!ref) throw new CelesteError('INVALID_ARGS', 'select requires a `ref`.');
  const value = str(params, 'value') ?? '';
  const result = await callContent(tabId, 'select', { ref, value });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function focus(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const ref = str(params, 'ref');
  if (!ref) throw new CelesteError('INVALID_ARGS', 'focus requires a `ref`.');
  const result = await callContent(tabId, 'focus', { ref });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function blur(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const result = await callContent(tabId, 'blur', { ref: str(params, 'ref') });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function tabs(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const action = str(params, 'action') ?? 'list';
  switch (action) {
    case 'list': {
      const found = await chrome.tabs.query({});
      return { tabs: found.map(toTabInfo) };
    }
    case 'create': {
      const url = str(params, 'url');
      const created = await chrome.tabs.create({
        url: url ? assertUrl(url) : 'about:blank',
        active: bool(params, 'active') !== false,
      });
      return { tab: toTabInfo(created) };
    }
    case 'close': {
      const target = num(params, 'tabId') ?? command.tabId;
      if (target === undefined) throw new CelesteError('INVALID_ARGS', 'tabs close requires a `tabId`.');
      await chrome.tabs.remove(target);
      return { ok: true, tabId: target };
    }
    case 'activate': {
      const target = num(params, 'tabId') ?? command.tabId;
      if (target === undefined) throw new CelesteError('INVALID_ARGS', 'tabs activate requires a `tabId`.');
      const updated = await chrome.tabs.update(target, { active: true });
      if (typeof updated.windowId === 'number') {
        await chrome.windows.update(updated.windowId, { focused: true }).catch(() => undefined);
      }
      return { ok: true, tab: toTabInfo(updated) };
    }
    default:
      throw new CelesteError('INVALID_ARGS', `Unknown tabs action: ${action}`);
  }
}

async function evaluate(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const expression = str(params, 'expression');
  if (!expression) throw new CelesteError('INVALID_ARGS', 'evaluate requires an `expression`.');
  const tabId = await resolveTabId(command.tabId);

  const runner = (source: string): { ok: boolean; value?: unknown; error?: string } => {
    try {
      // eslint-disable-next-line no-eval
      const value = (0, eval)(source);
      return { ok: true, value: value === undefined ? null : value };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runner,
      args: [expression],
    });
    const first = results[0];
    const payload = first?.result as { ok: boolean; value?: unknown; error?: string } | undefined;
    if (!payload) throw new CelesteError('INTERNAL', 'evaluate produced no result.');
    if (!payload.ok) return { value: null, error: payload.error ?? 'evaluation failed' };
    return { value: payload.value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CelesteError(
      'PERMISSION_DENIED',
      `evaluate failed in tab ${tabId}: ${message}. The page may forbid inline evaluation via its CSP.`,
    );
  }
}

async function extract(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const result = await callContent(tabId, 'extract', { selector: str(params, 'selector') });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function screenshot(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const format = (str(params, 'format') as 'png' | 'jpeg' | undefined) ?? 'png';
  const fullPage = bool(params, 'fullPage') === true;
  const tab = await chrome.tabs.get(tabId);

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format });
  const commaIndex = dataUrl.indexOf(',');
  const data = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;

  let width = 0;
  let height = 0;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ width: window.innerWidth, height: window.innerHeight }),
    });
    const first = results[0];
    const size = first?.result as { width?: number; height?: number } | undefined;
    width = size?.width ?? 0;
    height = size?.height ?? 0;
  } catch {
    /* ignore — dimension probing is best effort */
  }
  if (!width || !height) {
    const window_ = await chrome.windows.get(tab.windowId).catch(() => undefined);
    width = window_?.width ?? 0;
    height = window_?.height ?? 0;
  }

  return {
    mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    data,
    width,
    height,
    tabId,
    fullPage,
    // `chrome.tabs.captureVisibleTab` only ever captures the viewport. Full
    // page capture would require the debugger API, which we deliberately avoid.
    fullPageSupported: false,
  };
}

async function getText(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const result = (await callContent(tabId, 'getText', { selector: str(params, 'selector') })) as {
    text?: string;
  };
  return { tabId, text: result?.text ?? '' };
}

async function network(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const action = str(params, 'action') ?? 'list';
  if (action === 'clear') {
    networkLog.clear();
    return { cleared: true, count: 0 };
  }
  const filter = str(params, 'filter')?.toLowerCase();
  const scope = typeof command.tabId === 'number' && command.tabId >= 0 ? command.tabId : undefined;

  let entries = networkLog.all();
  if (scope !== undefined) entries = entries.filter((item) => item.tabId === scope);
  let wire = entries.map((item) => item.entry);
  if (filter) {
    wire = wire.filter(
      (entry) => entry.url.toLowerCase().includes(filter) || entry.method.toLowerCase().includes(filter),
    );
  }
  return { entries: wire, count: wire.length };
}

async function cookies(params: Record<string, unknown>): Promise<unknown> {
  const action = str(params, 'action') ?? 'get';
  const url = str(params, 'url');

  switch (action) {
    case 'get': {
      const found = url
        ? await chrome.cookies.getAll({ url: assertUrl(url) })
        : await chrome.cookies.getAll({});
      return {
        cookies: found.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          session: cookie.session,
          expirationDate: cookie.expirationDate,
        })),
        count: found.length,
      };
    }
    case 'set': {
      const name = str(params, 'name');
      if (!url) throw new CelesteError('INVALID_ARGS', 'cookies set requires a `url`.');
      if (!name) throw new CelesteError('INVALID_ARGS', 'cookies set requires a `name`.');
      const cookie = await chrome.cookies.set({
        url: assertUrl(url),
        name,
        value: str(params, 'value') ?? '',
        path: str(params, 'path') ?? '/',
        secure: bool(params, 'secure'),
        httpOnly: bool(params, 'httpOnly'),
      });
      if (!cookie) throw new CelesteError('INTERNAL', `The browser refused to set cookie "${name}".`);
      return { ok: true, cookie: { name: cookie.name, value: cookie.value, domain: cookie.domain } };
    }
    case 'clear': {
      const name = str(params, 'name');
      if (url && name) {
        await chrome.cookies.remove({ url: assertUrl(url), name });
        return { ok: true, removed: 1 };
      }
      // `chrome.cookies.removeAll` is not exposed by the type definitions, so
      // the cookies are removed one by one.
      const all = url ? await chrome.cookies.getAll({ url: assertUrl(url) }) : await chrome.cookies.getAll({});
      let removed = 0;
      for (const cookie of all) {
        try {
          const scheme = cookie.secure ? 'https' : 'http';
          const host = cookie.domain.replace(/^\./, '');
          await chrome.cookies.remove({ url: `${scheme}://${host}${cookie.path}`, name: cookie.name });
          removed += 1;
        } catch {
          /* skip cookies we are not allowed to remove */
        }
      }
      return { ok: true, removed };
    }
    default:
      throw new CelesteError('INVALID_ARGS', `Unknown cookies action: ${action}`);
  }
}

async function waitFor(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const timeoutMs = num(params, 'timeoutMs') ?? command.timeoutMs ?? 15_000;
  const result = await callContent(tabId, 'waitFor', {
    selector: str(params, 'selector'),
    text: str(params, 'text'),
    timeoutMs,
  });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function challenge(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const action = str(params, 'action') ?? 'detect';
  const detection = (await callContent(tabId, 'challenge', {})) as {
    detected?: boolean;
    kind?: string;
    confidence?: number;
  };
  const detected = detection?.detected === true;
  return {
    tabId,
    detected,
    kind: detection?.kind ?? null,
    confidence: detection?.confidence ?? 0,
    action,
    report: detected
      ? `A ${detection?.kind ?? 'bot'} challenge was detected (confidence ${detection?.confidence ?? 0}).`
      : 'No challenge detected.',
  };
}

async function consoleCommand(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const action = str(params, 'action') ?? 'list';
  if (action === 'clear') {
    consoleLog.clear();
    return { cleared: true, count: 0 };
  }
  const scope = typeof command.tabId === 'number' && command.tabId >= 0 ? command.tabId : undefined;
  let items = consoleLog.all();
  if (scope !== undefined) items = items.filter((item) => item.tabId === scope);
  const entries: ConsoleEntry[] = items.map((item) => item.entry);
  return { entries, count: entries.length };
}

async function highlight(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabId(command.tabId);
  const ref = str(params, 'ref');
  if (!ref) throw new CelesteError('INVALID_ARGS', 'highlight requires a `ref`.');
  const result = await callContent(tabId, 'highlight', { ref });
  return { tabId, ...(result as Record<string, unknown>) };
}

async function download(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const action = str(params, 'action') ?? 'list';
  switch (action) {
    case 'list': {
      const found = await chrome.downloads.search({ limit: 50 });
      const entries: DownloadEntry[] = found.map((item) => ({
        id: item.id,
        url: item.url,
        filename: item.filename,
        state: item.state,
        bytesReceived: item.bytesReceived,
        totalBytes: item.totalBytes,
        mime: item.mime,
        startedAt: Date.now(),
      }));
      return { downloads: entries, count: entries.length };
    }
    case 'save': {
      const url = str(params, 'url');
      const target = url ?? (await chrome.tabs.get(await resolveTabId(command.tabId))).url;
      if (!target) throw new CelesteError('INVALID_ARGS', 'download save requires a `url`.');
      const rawPath = str(params, 'path');
      const filename = rawPath ? rawPath.replace(/^[/\\]+/, '') : `celeste-${Date.now()}`;
      const downloadId = await chrome.downloads.download({
        url: target,
        filename,
        conflictAction: 'overwrite',
        saveAs: false,
      });
      return { ok: true, downloadId, url: target, filename, path: rawPath ?? null };
    }
    default:
      throw new CelesteError('INVALID_ARGS', `Unknown download action: ${action}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Web search                                                                 */
/* -------------------------------------------------------------------------- */

const SEARCH_ENGINES: Record<string, (query: string, limit: number) => string> = {
  bing: (q, n) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${n}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=web`,
  brave: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
};

/**
 * Runs a web search in the user's real browser.
 *
 * Going through the browser instead of a bare HTTP request is deliberate:
 * search engines aggressively block plain fetch clients, while the real
 * browser — with its cookies, its fingerprint and its JavaScript — is exactly
 * what they expect to see. The page is opened in a background tab, the
 * results are read out of the live DOM, and the tab is closed again.
 */
async function search(command: BrowserCommand, params: Record<string, unknown>): Promise<unknown> {
  const query = str(params, 'query')?.trim();
  if (!query) throw new CelesteError('INVALID_ARGS', 'A search query is required.');

  const engineName = str(params, 'engine') ?? 'bing';
  const buildUrl = SEARCH_ENGINES[engineName];
  if (!buildUrl) {
    throw new CelesteError(
      'INVALID_ARGS',
      `Unknown search engine "${engineName}". Use bing, duckduckgo, brave or google.`,
    );
  }

  const limit = Math.min(Math.max(num(params, 'limit') ?? 8, 1), 20);
  const keepTab = params['keepTab'] === true;
  const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = buildUrl(query, limit);

  // Open the engine in a background tab so the user's current page stays put.
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  if (typeof tabId !== 'number') {
    throw new CelesteError('INTERNAL', 'The browser did not return a tab for the search.');
  }

  try {
    await waitForLoad(tabId, timeoutMs, 'load');

    // Give a client-rendered engine a moment to paint its results.
    const deadline = Date.now() + 4_000;
    let extracted: { results?: unknown[] } = {};
    while (Date.now() < deadline) {
      extracted = (await callContent(tabId, 'extractSearchResults', { limit })) as {
        results?: unknown[];
      };
      if (Array.isArray(extracted.results) && extracted.results.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const results = Array.isArray(extracted.results) ? extracted.results : [];
    return { engine: engineName, query, url, results };
  } finally {
    if (!keepTab) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* the user may have closed it already */
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export async function dispatchCommand(command: BrowserCommand): Promise<unknown> {
  const action = command.action;
  const params = command.params ?? {};

  switch (action) {
    case 'navigate':
      return navigate(command, params);
    case 'back':
      return history(command, 'back');
    case 'forward':
      return history(command, 'forward');
    case 'reload':
      return reload(command);
    case 'snapshot':
      return snapshot(command, params);
    case 'click':
      return click(command, params);
    case 'type':
      return type(command, params);
    case 'fill':
      return fill(command, params);
    case 'press':
      return press(command, params);
    case 'scroll':
      return scroll(command, params);
    case 'hover':
      return hover(command, params);
    case 'select':
      return select(command, params);
    case 'focus':
      return focus(command, params);
    case 'blur':
      return blur(command, params);
    case 'tabs':
      return tabs(command, params);
    case 'evaluate':
      return evaluate(command, params);
    case 'extract':
      return extract(command, params);
    case 'screenshot':
      return screenshot(command, params);
    case 'getText':
      return getText(command, params);
    case 'network':
      return network(command, params);
    case 'cookies':
      return cookies(params);
    case 'waitFor':
      return waitFor(command, params);
    case 'challenge':
      return challenge(command, params);
    case 'console':
      return consoleCommand(command, params);
    case 'highlight':
      return highlight(command, params);
    case 'download':
      return download(command, params);
    case 'search':
      return search(command, params);
    default:
      throw new CelesteError('INVALID_ARGS', `Unknown browser action: ${String(action)}`);
  }
}

/** Exposed for the background worker so it can label pending commands. */
export function describeCommand(command: BrowserCommand): string {
  const ref = command.params?.['ref'];
  const refText = typeof ref === 'string' ? ` ref=${ref}` : '';
  return `${command.action}${refText}`;
}

export type { ElementRef };
