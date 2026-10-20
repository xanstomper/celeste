import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

/**
 * Launches a visible browser with the Celeste agent panel already open.
 *
 * This is the Comet model: you browse normally, and the agent lives in a side
 * panel beside the page.
 */

export interface BrowserCandidate {
  id: string;
  label: string;
  bin: string;
}

const BROWSERS: BrowserCandidate[] = [
  { id: 'brave', label: 'Brave', bin: 'brave-browser' },
  { id: 'brave-beta', label: 'Brave Beta', bin: 'brave-browser-beta' },
  { id: 'chrome', label: 'Google Chrome', bin: 'google-chrome' },
  { id: 'chromium', label: 'Chromium', bin: 'chromium' },
  { id: 'chromium-browser', label: 'Chromium', bin: 'chromium-browser' },
];

export interface BrowseOptions {
  /** URL(s) to open. */
  urls: string[];
  /** Preferred browser id. */
  browser?: string;
  /** Profile directory. Defaults to a Celeste-specific one. */
  profileDir?: string;
  /** Use the user's real browser profile instead of a dedicated one. */
  useRealProfile?: boolean;
  /** DevTools port used to open the panel automatically. */
  debugPort?: number;
  /** Skip opening the side panel. */
  noPanel?: boolean;
}

export interface BrowseResult {
  browser: BrowserCandidate;
  pid?: number;
  profileDir: string;
  extensionDir: string | null;
  panelOpened: boolean;
  display: string;
}

/** Locates an installed Chromium-family browser. */
export function findBrowser(preferred?: string): BrowserCandidate | null {
  const ordered = preferred
    ? [...BROWSERS.filter((b) => b.id === preferred), ...BROWSERS.filter((b) => b.id !== preferred)]
    : BROWSERS;

  for (const candidate of ordered) {
    for (const dir of ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/brave.com/brave']) {
      const full = path.join(dir, candidate.bin);
      if (existsSync(full)) return { ...candidate, bin: full };
    }
  }
  return null;
}

/** Path to the built extension, or null when it has not been built. */
export function extensionPath(): string | null {
  // Walk up from the running module until the workspace layout is found, so
  // this works from `apps/cli/dist`, from a global install, and from a
  // symlinked binary alike.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, 'packages', 'extension', 'dist');
    if (existsSync(path.join(candidate, 'manifest.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Side panel                                                                 */
/* -------------------------------------------------------------------------- */

/** Minimal DevTools protocol client. */
class Cdp {
  private id = 0;
  private readonly pending = new Map<number, (value: any) => void>();

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const resolver = this.pending.get(message.id);
      if (resolver) {
        this.pending.delete(message.id);
        resolver(message);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression in the page and returns its value. */
  async evaluate(expression: string, userGesture = false): Promise<any> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(userGesture ? { userGesture: true } : {}),
    });
    if (result?.exceptionDetails) {
      const details = result.exceptionDetails;
      const message =
        details.exception?.description ?? details.text ?? JSON.stringify(details);
      throw new Error(`evaluation failed: ${message}`);
    }
    return result?.result?.result?.value;
  }

  /** Dispatches a real mouse click, which counts as a user gesture. */
  async click(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Set CELESTE_DEBUG=1 to trace the panel-opening sequence. */
const trace = (message: string): void => {
  if (process.env.CELESTE_DEBUG) process.stderr.write(`[celeste:browse] ${message}\n`);
};

/** A DevTools target as reported by /json/list. */
interface DevToolsTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * Opens the side panel.
 *
 * `chrome.sidePanel.open()` refuses to run without a user gesture, and a
 * gesture does not survive the trip from a content script into the service
 * worker. A real synthetic click inside one of the extension's own pages
 * does, so that is what we do: open the extension's helper page, click it,
 * and the panel docks itself.
 */
async function openSidePanel(debugPort: number, urls: string[] = []): Promise<boolean> {
  // Wait for the DevTools endpoint *and* the extension's service worker —
  // the debugger comes up long before the extension does.
  let targets: DevToolsTarget[] = [];
  let worker: DevToolsTarget | undefined;

  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (res.ok) {
        targets = (await res.json()) as DevToolsTarget[];
        worker = targets.find(
          (t) => t.type === 'service_worker' && t.url.includes('chrome-extension://'),
        );
        if (worker) break;
        // Already open? Nothing to do.
        if (targets.some((t) => t.url.includes('sidepanel.html'))) return true;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }

  trace(`devtools ready, worker=${Boolean(worker)}`);
  if (!worker) return false;

  const extensionId = new URL(worker.url).host;
  trace(`extension id ${extensionId}`);

  // Open a helper page inside the extension and open the panel from there.
  let tab: DevToolsTarget | null = null;
  try {
    const res = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?chrome-extension://${extensionId}/openpanel.html`,
      { method: 'PUT' },
    );
    tab = (await res.json()) as DevToolsTarget;
    trace(`helper tab ${tab?.id}`);
  } catch (err) {
    trace(`helper tab failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const page = await Cdp.connect(tab.webSocketDebuggerUrl);
  try {
    // `userGesture: true` makes the evaluation count as a user gesture,
    // which is what `chrome.sidePanel.open()` insists on.
    //
    // The window is chosen by looking for the tab we asked the browser to
    // open. On a fresh profile Brave shows a welcome tab that owns the
    // focus, and opening the panel there would put it in the wrong window.
    const wanted = JSON.stringify(urls.filter((u) => u !== 'about:blank'));
    const expression = `chrome.tabs.query({}).then((tabs) => {
         let target = tabs.find((t) => t.url && ${wanted}.some((u) => t.url.startsWith(u)));
         if (!target) target = tabs.find((t) => t.url && !t.url.startsWith('chrome-extension://'));
         if (target && typeof target.windowId === 'number') {
           return chrome.sidePanel.open({ windowId: target.windowId });
         }
         return chrome.windows.getAll({}).then((w) => chrome.sidePanel.open({ windowId: (w.find((x) => x.focused) || w[0]).id }));
       }).then(() => 'OPENED').catch((e) => 'ERR:' + e.message)`;

    // The extension's page may not be fully initialised on the very first
    // try, so give it a couple of attempts.
    let result: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(600);
      try {
        result = await page.evaluate(expression, true);
      } catch (err) {
        trace(`attempt ${attempt + 1} threw: ${err instanceof Error ? err.message : String(err)}`);
        result = undefined;
      }
      if (result === 'OPENED') break;
      trace(`attempt ${attempt + 1} -> ${String(result)}`);
    }
    if (result !== 'OPENED') return false;
  } catch {
    return false;
  } finally {
    page.close();
    // Close the helper tab again.
    void fetch(`http://127.0.0.1:${debugPort}/json/close/${tab.id}`).catch(() => undefined);
  }

  // The panel target takes a moment to appear after the open resolves.
  for (let attempt = 0; attempt < 20; attempt++) {
    const after = (await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    ).json()) as DevToolsTarget[];
    const open = after.some((t) => t.url.includes('sidepanel.html'));
    if (open) {
      trace('panel open = true');
      return true;
    }
    await sleep(250);
  }
  trace('panel open = false');
  return false;
}

/* -------------------------------------------------------------------------- */
/* Launch                                                                      */
/* -------------------------------------------------------------------------- */

export interface LaunchedBrowser {
  browser: BrowserCandidate;
  pid?: number;
  profileDir: string;
  extensionDir: string | null;
  debugPort: number;
}

/** Finds a free TCP port so two browsers never fight over the debugger. */
async function freePort(preferred?: number): Promise<number> {
  const { createServer } = await import('node:net');

  const tryPort = (port: number): Promise<number | null> =>
    new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(null));
      server.once('listening', () => {
        const address = server.address();
        const actual = typeof address === 'object' && address ? address.port : port;
        server.close(() => resolve(actual));
      });
      server.listen(port, '127.0.0.1');
    });

  if (preferred) {
    const found = await tryPort(preferred);
    if (found !== null) return found;
  }
  // Ask the OS for an ephemeral port.
  const fallback = await tryPort(0);
  return fallback ?? 9222;
}

/** Starts the browser. */
export async function launch(options: BrowseOptions): Promise<LaunchedBrowser> {
  const browser = findBrowser(options.browser);
  if (!browser) {
    throw new Error(
      'No Chromium-family browser found. Install Brave or Chrome, or pass --browser <id>.',
    );
  }

  const extensionDir = extensionPath();
  const profileDir =
    options.profileDir ?? path.join(homedir(), '.celeste', 'browser-profile');
  const debugPort = await freePort(options.debugPort);

  if (!options.useRealProfile) {
    mkdirSync(profileDir, { recursive: true });
  }

  const args: string[] = [];

  if (extensionDir) {
    args.push(`--load-extension=${extensionDir}`);
  }

  if (!options.useRealProfile) {
    args.push(`--user-data-dir=${profileDir}`);
    args.push('--no-first-run');
    args.push('--no-default-browser-check');
  }

  // The DevTools port is how the side panel gets opened automatically.
  args.push(`--remote-debugging-port=${debugPort}`);

  const urls = options.urls.length > 0 ? options.urls : ['about:blank'];

  const child = spawn(browser.bin, [...args, ...urls], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  return { browser, pid: child.pid, profileDir, extensionDir, debugPort };
}

export interface BrowseResult {
  browser: BrowserCandidate;
  pid?: number;
  profileDir: string;
  extensionDir: string | null;
  panelOpened: boolean;
  display: string;
}

/**
 * Launches the browser and opens the agent panel in it.
 */
export async function browse(options: BrowseOptions): Promise<BrowseResult> {
  const launched = await launch(options);

  let panelOpened = false;
  if (!options.noPanel) {
    try {
      panelOpened = await openSidePanel(launched.debugPort, options.urls);
    } catch {
      panelOpened = false;
    }
  }

  return {
    browser: launched.browser,
    pid: launched.pid,
    profileDir: options.useRealProfile ? '(your default profile)' : launched.profileDir,
    extensionDir: launched.extensionDir,
    panelOpened,
    display: process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '',
  };
}
