/**
 * Celeste background service worker (Manifest V3).
 *
 * Responsibilities:
 *  - own the websocket connection to the local daemon (the daemon cannot dial
 *    into the browser, so the extension dials out)
 *  - decode `browser.command` envelopes, dispatch them, and reply with
 *    `browser.result` envelopes
 *  - survive MV3 worker eviction by re-arming a `chrome.alarms` keep-alive
 *  - forward browser events (navigation, tabs, network, console, …) to the
 *    daemon as `event` messages
 *
 * Everything crossing the socket boundary is a `ProtocolErrorShape`; raw
 * exceptions never escape.
 */

import { Bridge, WORKER_INSTANCE_ID } from './bridge.js';
import { CelesteError, PROTOCOL_VERSION, createId, decodeServerMessage, encodeClientMessage } from './protocol.js';
import type { BrowserCommand, BrowserResultEnvelope, ExtensionEvent, ServerMessage } from './protocol.js';
import { dispatchCommand, ensureContentScript } from './dispatcher.js';
import { consoleLog, downloadLog, forgetTab, networkLog, recordNetworkEntry } from './state.js';
import type { BridgeState, ConsoleEntry, DownloadEntry } from './types.js';
import type { NetworkEntry } from './protocol.js';
import { releaseDebugger } from './debugger.js';
import { setFrameSink } from './viewport.js';

const DEFAULT_PORT = 9223;
const PORT_KEY = 'bridgePort';
const KEEPALIVE_ALARM = 'celeste:keepalive';
const OUTBOX_LIMIT = 250;

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

async function readPort(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(PORT_KEY);
    const raw = stored[PORT_KEY];
    const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) return parsed;
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_PORT;
}

async function writePort(port: number): Promise<void> {
  await chrome.storage.local.set({ [PORT_KEY]: port });
}

/* -------------------------------------------------------------------------- */
/* Bridge                                                                      */
/* -------------------------------------------------------------------------- */

const bridge = new Bridge({
  getPort: readPort,
  onEvent: (event) => {
    if (event.type === 'state') {
      broadcastState(event.state);
      return;
    }
    if (event.type === 'message') {
      void handleServerMessage(event.raw);
      return;
    }
    if (event.type === 'open') {
      // Announce ourselves so the daemon can tell a fresh worker instance
      // apart from a dropped socket.
      const hello = encodeClientMessage({
        v: PROTOCOL_VERSION,
        type: 'hello',
        payload: {
          version: PROTOCOL_VERSION,
          worker: WORKER_INSTANCE_ID,
          stack: bridge.getConnectStack(),
          state: bridge.getState(),
        },
      });
      if (!bridge.send(hello)) enqueue(hello);
      return;
    }
    if (event.type === 'close') {
      failPendingCommands(`The connection to the daemon closed (code ${event.code}).`);
      return;
    }
    if (event.type === 'error') {
      // Surface the socket's failure reason to the daemon so a broken
      // connection can be diagnosed without opening devtools.
      const diag = encodeClientMessage({
        v: PROTOCOL_VERSION,
        type: 'event',
        payload: {
          type: 'celeste:diagnostic',
          payload: {
            message: event.message ?? 'websocket error',
            state: bridge.getState(),
            at: Date.now(),
          },
          timestamp: Date.now(),
        } satisfies ExtensionEvent,
      });
      if (!bridge.send(diag)) enqueue(diag);
    }
  },
});

/** Messages that could not be delivered because the socket was down. */
const outbox: string[] = [];

// Live viewport frames go straight to the daemon as they are captured.
setFrameSink((frame) => {
  const message = encodeClientMessage({
    v: PROTOCOL_VERSION,
    type: 'viewport.frame',
    payload: frame,
  });
  if (!bridge.send(message)) enqueue(message);
});

function enqueue(raw: string): void {
  outbox.push(raw);
  while (outbox.length > OUTBOX_LIMIT) outbox.shift();
}

function flushOutbox(): void {
  while (outbox.length > 0) {
    const raw = outbox[0];
    if (!raw) break;
    if (!bridge.send(raw)) break;
    outbox.shift();
  }
}

function broadcastState(state: BridgeState): void {
  void chrome.runtime
    .sendMessage({ type: 'celeste:state', state })
    .catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Pending commands                                                            */
/* -------------------------------------------------------------------------- */

interface PendingCommand {
  id: string;
  action: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingCommand>();

function sendResult(id: string, payload: BrowserResultEnvelope['payload']): void {
  const envelope: BrowserResultEnvelope = {
    v: PROTOCOL_VERSION,
    type: 'browser.result',
    id,
    payload,
  };
  const raw = encodeClientMessage(envelope);
  if (!bridge.send(raw)) {
    enqueue(raw);
    return;
  }
  flushOutbox();
}

function failPendingCommands(reason: string): void {
  if (pending.size === 0) return;
  const failures = Array.from(pending.values());
  pending.clear();
  for (const command of failures) {
    clearTimeout(command.timer);
    const error: CelesteError = new CelesteError('NETWORK_ERROR', `${reason} Command "${command.action}" was aborted.`, {
      retryable: true,
    });
    sendResult(command.id, { ok: false, error: error.toShape() });
  }
}

/* -------------------------------------------------------------------------- */
/* Daemon → extension                                                          */
/* -------------------------------------------------------------------------- */

async function handleServerMessage(raw: string): Promise<void> {
  let message: ServerMessage;
  try {
    message = decodeServerMessage(raw);
  } catch {
    return;
  }

  switch (message.type) {
    case 'browser.command': {
      const id = typeof message.id === 'string' && message.id ? message.id : createId('cmd');
      const command = (message.payload ?? {}) as BrowserCommand;
      void executeCommand(id, command);
      return;
    }
    case 'ping': {
      const pong = encodeClientMessage({ v: PROTOCOL_VERSION, type: 'pong', id: message.id });
      if (!bridge.send(pong)) enqueue(pong);
      return;
    }
    case 'welcome':
    case 'pong':
    case 'event':
    case 'approval.request':
    case 'approval.response':
    case 'error':
      return;
    default:
      return;
  }
}

async function executeCommand(id: string, command: BrowserCommand): Promise<void> {
  const timeoutMs = command.timeoutMs && command.timeoutMs > 0 ? command.timeoutMs : 30_000;
  const action = typeof command.action === 'string' ? command.action : 'unknown';

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new CelesteError('TIMEOUT', `Command "${action}" timed out after ${timeoutMs}ms.`, {
          retryable: true,
          details: { action, timeoutMs },
        }),
      );
    }, timeoutMs);
  });

  pending.set(id, {
    id,
    action,
    startedAt: Date.now(),
    timer: timer ?? setTimeout(() => undefined, 0),
  });

  try {
    const result = await Promise.race([dispatchCommand(command), timeout]);
    sendResult(id, { ok: true, result: result ?? null });
  } catch (err) {
    const error = CelesteError.from(err, 'INTERNAL');
    sendResult(id, { ok: false, error: error.toShape() });
  } finally {
    const entry = pending.get(id);
    if (entry) clearTimeout(entry.timer);
    pending.delete(id);
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Extension → daemon                                                          */
/* -------------------------------------------------------------------------- */

function emitEvent(event: ExtensionEvent): void {
  const raw = encodeClientMessage({
    v: PROTOCOL_VERSION,
    type: 'event',
    id: createId('ev'),
    payload: event,
  });
  if (!bridge.send(raw)) {
    enqueue(raw);
    return;
  }
  flushOutbox();
}

/* -------------------------------------------------------------------------- */
/* Runtime messaging (popup + content script)                                  */
/* -------------------------------------------------------------------------- */

interface RuntimeMessage {
  /** The passage the user selected on the page, when they asked about one. */
  selection?: string;
  type?: string;
  event?: ExtensionEvent;
  port?: number;
  entry?: NetworkEntry;
  console?: ConsoleEntry;
  /** Page URL for the in-page "Ask" button. */
  url?: string;
  /** Page title for the in-page "Ask" button. */
  title?: string;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msg = (message ?? {}) as RuntimeMessage;

  switch (msg.type) {
    case 'celeste:ask': {
      // The page's "Ask" button: hand the request to the daemon over the
      // bridge and bring the agent panel forward if we can.
      void (async () => {
        const url = String(msg.url ?? '');
        const title = String(msg.title ?? '');
        const selection = String(msg.selection ?? '').trim();
        const prompt = selection
          ? `Look at the page open in the browser at ${url}${title ? ` ("${title}")` : ''}. I selected this passage:\n\n"\"\"\n${selection}\n"\"\"\n\nExplain it clearly, and answer whatever question it raises.`
          : `Analyse the page currently open in the browser at ${url}${
              title ? ` ("${title}")` : ''
            }. Summarise what it says, extract the key facts, and tell me what it is about.`;

        const request = encodeClientMessage({
          v: PROTOCOL_VERSION,
          type: 'task.request',
          payload: { prompt, url, title },
        });
        if (!bridge.send(request)) enqueue(request);

        // Try to bring the panel forward. It usually already has the gesture.
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const windowId = tabs[0]?.windowId;
          if (typeof windowId === 'number') {
            await chrome.sidePanel.open({ windowId });
          }
        } catch {
          /* the user can click the toolbar icon */
        }
        sendResponse({ ok: true });
      })();
      return true;
    }

    case 'celeste:open-panel': {
      // Triggered by the in-page "Ask" button. The click is a user gesture,
      // so the side panel can be opened without the user hunting for the
      // toolbar button.
      void (async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const windowId = tabs[0]?.windowId;
        if (typeof windowId !== 'number') {
          sendResponse({ ok: false, error: 'No active window.' });
          return;
        }
        try {
          await chrome.sidePanel.open({ windowId });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }

    case 'celeste:status': {
      void (async () => {
        const state = bridge.getState();
        sendResponse({ ok: true, state });
      })();
      return true;
    }

    case 'celeste:ping': {
      void (async () => {
        const startedAt = Date.now();
        if (!bridge.isOpen) {
          sendResponse({ ok: false, error: 'Not connected to the daemon.' });
          return;
        }
        const pong = encodeClientMessage({ v: PROTOCOL_VERSION, type: 'ping', id: createId('ping') });
        if (!bridge.send(pong)) {
          sendResponse({ ok: false, error: 'Could not send the ping.' });
          return;
        }
        sendResponse({ ok: true, latencyMs: Date.now() - startedAt });
      })();
      return true;
    }

    case 'celeste:set-port': {
      void (async () => {
        const port = Number(msg.port);
        if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
          sendResponse({ ok: false, error: 'Invalid port.' });
          return;
        }
        await writePort(port);
        bridge.stop();
        await bridge.start();
        sendResponse({ ok: true, state: bridge.getState() });
      })();
      return true;
    }

    case 'celeste:event': {
      const event = msg.event;
      if (event) {
        const tabId = sender.tab?.id ?? -1;
        if (event.type === 'network.captured') {
          const entry = event.payload as NetworkEntry | undefined;
          if (entry && typeof entry.url === 'string') {
            recordNetworkEntry(tabId, entry);
          }
        } else if (event.type === 'console.message') {
          const entry = event.payload as ConsoleEntry | undefined;
          if (entry && typeof entry.text === 'string') {
            consoleLog.push({
              tabId,
              entry: {
                level: entry.level ?? 'log',
                text: entry.text,
                timestamp: entry.timestamp ?? Date.now(),
                ...(entry.url ? { url: entry.url } : {}),
                ...(entry.source ? { source: entry.source } : {}),
              },
            });
          }
        }
        emitEvent(event);
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'celeste:ensure-hook': {
      void (async () => {
        const tabId = sender.tab?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, error: 'No tab.' });
          return;
        }
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            files: ['page-hook.js'],
          });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }

    case 'celeste:ensure-content': {
      void (async () => {
        const tabId = sender.tab?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, error: 'No tab.' });
          return;
        }
        try {
          await ensureContentScript(tabId);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }

    case 'celeste:tab-info': {
      void (async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        sendResponse({
          ok: true,
          tab: tab
            ? { id: tab.id, title: tab.title ?? '', url: tab.url ?? '', favIconUrl: tab.favIconUrl }
            : null,
        });
      })();
      return true;
    }

    default:
      sendResponse({ ok: false, error: `Unknown message: ${String(msg.type)}` });
      return false;
  }
});

/* -------------------------------------------------------------------------- */
/* Browser events → daemon                                                     */
/* -------------------------------------------------------------------------- */

chrome.tabs.onCreated.addListener((tab) => {
  emitEvent({ type: 'tab.created', payload: { id: tab.id, title: tab.title ?? '', url: tab.url ?? '' }, timestamp: Date.now() });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void releaseDebugger();
  forgetTab(tabId);
  emitEvent({ type: 'tab.removed', payload: { id: tabId }, timestamp: Date.now() });
});

chrome.tabs.onActivated.addListener((info) => {
  // The user moved on: let go of the debugger so the "debugging" banner goes
  // away with them.
  void releaseDebugger();
  emitEvent({ type: 'tab.activated', payload: { tabId: info.tabId, windowId: info.windowId }, timestamp: Date.now() });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    emitEvent({ type: 'page.navigated', payload: { tabId, url: changeInfo.url }, timestamp: Date.now() });
  }
  if (changeInfo.status === 'complete') {
    emitEvent({
      type: 'page.loaded',
      payload: { tabId, url: tab.url ?? changeInfo.url ?? '', title: tab.title ?? '' },
      timestamp: Date.now(),
    });
  }
  if (typeof changeInfo.title === 'string' && changeInfo.title) {
    emitEvent({ type: 'page.title', payload: { tabId, title: changeInfo.title }, timestamp: Date.now() });
  }
});

if (chrome.webNavigation) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    emitEvent({
      type: 'page.navigated',
      payload: { tabId: details.tabId, url: details.url, transition: details.transitionType },
      timestamp: Date.now(),
    });
  });
}

chrome.downloads.onCreated.addListener((item) => {
  const entry: DownloadEntry = {
    id: item.id,
    url: item.url,
    filename: item.filename,
    state: item.state,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    mime: item.mime,
    startedAt: Date.now(),
  };
  downloadLog.push(entry);
});

/* -------------------------------------------------------------------------- */
/* Keep-alive                                                                  */
/* -------------------------------------------------------------------------- */

function armKeepalive(): void {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.1 });
  } catch {
    /* ignore */
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  void bridge.ensureConnected();
});

chrome.runtime.onInstalled.addListener(() => {
  armKeepalive();
  void bridge.ensureConnected();
});

chrome.runtime.onStartup.addListener(() => {
  armKeepalive();
  void bridge.ensureConnected();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!(PORT_KEY in changes)) return;
  bridge.stop();
  void bridge.start();
});

/* -------------------------------------------------------------------------- */
/* Side panel                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The side panel is Celeste's home: the agent lives in the browser, beside
 * the page you are reading, exactly like Perplexity's Comet assistant.
 */
function armSidePanel(): void {
  try {
    // Clicking the toolbar icon opens the panel instead of a popup.
    void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true })?.catch?.(() => {});
  } catch {
    /* the API is unavailable on older browsers */
  }
}

chrome.action?.onClicked?.addListener((tab) => {
  if (typeof tab?.windowId === 'number') {
    void chrome.sidePanel?.open({ windowId: tab.windowId })?.catch?.(() => {});
  }
});

chrome.commands?.onCommand?.addListener((command) => {
  if (command !== '_execute_action') return;
  void chrome.tabs
    ?.query({ active: true, currentWindow: true })
    ?.then((tabs) => {
      const windowId = tabs[0]?.windowId;
      if (typeof windowId === 'number') {
        return chrome.sidePanel?.open({ windowId });
      }
      return undefined;
    })
    ?.catch?.(() => {});
});

chrome.runtime.onInstalled.addListener(() => armSidePanel());
chrome.runtime.onStartup.addListener(() => armSidePanel());

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

armKeepalive();
armSidePanel();
void bridge.start();

// Expose a tiny surface for the smoke test / debugging from the service
// worker console.
(globalThis as unknown as { __celeste?: unknown }).__celeste = {
  bridge,
  dispatch: dispatchCommand,
  network: networkLog,
  console: consoleLog,
};
