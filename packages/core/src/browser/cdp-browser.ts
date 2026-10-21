import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { BrowserClient } from '@celeste/tools';

export interface CdpTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
  faviconUrl?: string;
}

export interface CdpBrowserOptions {
  debugPort?: number;
  browserBin?: string;
  profileDir?: string;
  extensionDir?: string;
}

/**
 * Autonomous CDP Browser Controller.
 *
 * Drives Chrome/Brave directly over the Chrome DevTools Protocol (port 9222).
 * Celeste is a self-contained webwrapper: it does NOT require an extension to be
 * manually installed or connected. It auto-spawns and controls the browser directly.
 */
export class CdpBrowser implements BrowserClient {
  private readonly port: number;
  private readonly browserBin: string;
  private readonly profileDir: string;
  private readonly extensionDir?: string;
  private activeWs: WebSocket | null = null;
  private activePageId: string | null = null;
  private idCounter = 0;
  private readonly pending = new Map<number, (res: any) => void>();
  private activeTabUrl = 'about:blank';
  private activeTabTitle = 'New Tab';
  private lastActiveTime = 0;

  constructor(options: CdpBrowserOptions = {}) {
    this.port = options.debugPort ?? 9222;
    this.browserBin = options.browserBin ?? '/usr/bin/brave-browser';
    this.profileDir = options.profileDir ?? path.join(homedir(), '.celeste', 'browser-profile');
    this.extensionDir = options.extensionDir;
  }

  /** Checks if the CDP debug port is alive. */
  async isAlive(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(1200),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return true; // Autonomous webwrapper is always ready or auto-launches
  }

  /** Ensures a Chromium/Brave instance is running with CDP enabled. */
  async ensureBrowser(): Promise<void> {
    if (await this.isAlive()) {
      return;
    }

    // Clean up any stale singleton locks from previous crashes/reboots
    try {
      const lock1 = path.join(this.profileDir, 'SingletonLock');
      const lock2 = path.join(this.profileDir, 'SingletonSocket');
      const lock3 = path.join(this.profileDir, 'SingletonCookie');
      if (existsSync(lock1)) rmSync(lock1, { force: true });
      if (existsSync(lock2)) rmSync(lock2, { force: true });
      if (existsSync(lock3)) rmSync(lock3, { force: true });
    } catch {
      /* ignore */
    }

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-features=Vulkan,WebGPU',
      '--enable-unsafe-webgpu',
      '--window-size=1280,800',
    ];

    if (this.extensionDir && existsSync(this.extensionDir)) {
      args.push(`--load-extension=${this.extensionDir}`);
    }

    // Launch detached browser process
    const child = spawn(this.browserBin, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    });
    child.unref();

    // Poll until CDP is responsive (up to 6 seconds)
    const start = Date.now();
    while (Date.now() - start < 6000) {
      if (await this.isAlive()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Lists open pages / tabs. */
  async listPages(): Promise<CdpTarget[]> {
    await this.ensureBrowser();
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return [];
      const targets = (await res.json()) as CdpTarget[];
      return targets.filter((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
    } catch {
      return [];
    }
  }

  /** Connects to the active page target via WebSocket. */
  async getPageWs(): Promise<WebSocket> {
    await this.ensureBrowser();
    const pages = await this.listPages();
    let page = pages[0];

    if (!page) {
      // Create a blank page if none exist
      const createRes = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, {
        method: 'PUT',
      });
      page = (await createRes.json()) as CdpTarget;
    }

    if (this.activeWs && this.activePageId === page.id && this.activeWs.readyState === WebSocket.OPEN) {
      return this.activeWs;
    }

    if (this.activeWs) {
      try {
        this.activeWs.close();
      } catch {
        /* ignore */
      }
    }

    const wsUrl = page.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('No WebSocket debugger URL on page target');

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 4000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const resolver = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolver?.(msg);
        }
      } catch {
        /* ignore */
      }
    });

    this.activeWs = ws;
    this.activePageId = page.id;
    this.activeTabUrl = page.url;
    this.activeTabTitle = page.title;
    this.lastActiveTime = Date.now();

    // Enable Page and DOM domains
    await this.cdpSend('Page.enable');
    await this.cdpSend('DOM.enable');
    return ws;
  }

  private async cdpSend(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const ws = await this.getPageWs();
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, 20000);

      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      });

      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression inside the active page. */
  async evaluate(expression: string, userGesture = false): Promise<any> {
    const res = await this.cdpSend('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture,
    });
    return res?.result?.value;
  }

  /** Navigates to a URL and waits for page load. */
  async navigate(url: string): Promise<{ url: string; title: string }> {
    let targetUrl = url.trim();
    if (!/^https?:\/\//i.test(targetUrl) && !targetUrl.startsWith('about:')) {
      targetUrl = `https://${targetUrl}`;
    }
    await this.cdpSend('Page.navigate', { url: targetUrl });
    // Wait brief duration for navigation
    await new Promise((r) => setTimeout(r, 800));
    const title = (await this.evaluate('document.title')) || 'Untitled';
    const finalUrl = (await this.evaluate('location.href')) || targetUrl;
    this.activeTabUrl = finalUrl;
    this.activeTabTitle = title;
    return { url: finalUrl, title };
  }

  /** Captures a base64 JPEG screenshot. */
  async screenshot(): Promise<{ data: string; mimeType: string }> {
    const res = await this.cdpSend('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 75,
      fromSurface: true,
    });
    return {
      data: res?.data ?? '',
      mimeType: 'image/jpeg',
    };
  }

  /** Dispatches a real mouse click with an injected ripple marker on the page. */
  async click(x: number, y: number): Promise<{ x: number; y: number }> {
    // Inject visible animated click ripple onto page
    const visualScript = `(() => {
      try {
        const id = 'celeste-live-ripple';
        document.getElementById(id)?.remove();
        const el = document.createElement('div');
        el.id = id;
        el.style.cssText = 'position:fixed;left:${x}px;top:${y}px;width:32px;height:32px;margin:-16px 0 0 -16px;border-radius:50%;border:2px solid #00f2fe;box-shadow:0 0 16px #00f2fe;pointer-events:none;z-index:2147483647;animation:celesteRip 0.6s ease-out forwards;';
        if (!document.getElementById('celeste-rip-style')) {
          const st = document.createElement('style');
          st.id = 'celeste-rip-style';
          st.textContent = '@keyframes celesteRip { 0% { transform:scale(0.3); opacity:1; } 100% { transform:scale(1.8); opacity:0; } }';
          document.head.appendChild(st);
        }
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 700);
      } catch (e) {}
    })()`;
    void this.evaluate(visualScript).catch(() => {});

    // Real CDP mouse events
    await this.cdpSend('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await this.cdpSend('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.cdpSend('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    return { x, y };
  }

  /** Inserts text via keyboard events into the currently focused element. */
  async type(text: string): Promise<void> {
    await this.cdpSend('Input.insertText', { text });
  }

  /** Captures semantic snapshot of interactive elements with refs. */
  async snapshot(maxElements = 150): Promise<any> {
    const expression = `(() => {
      const items = [];
      const nodes = Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], h1, h2, h3, p, form, table'));
      let counter = 1;
      for (const node of nodes) {
        if (items.length >= ${maxElements}) break;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        
        const ref = 'e' + (counter++);
        node.setAttribute('data-celeste-ref', ref);
        const text = (node.innerText || node.textContent || node.placeholder || node.value || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        items.push({
          ref,
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute('role') || node.tagName.toLowerCase(),
          name: text,
          visible: true,
          box: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        });
      }
      return {
        url: location.href,
        title: document.title,
        elements: items
      };
    })()`;
    return (await this.evaluate(expression)) || { url: this.activeTabUrl, title: this.activeTabTitle, elements: [] };
  }

  /** Implements the BrowserClient send() interface. */
  async send<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    switch (action) {
      case 'navigate': {
        const url = String(params.url || 'about:blank');
        return (await this.navigate(url)) as unknown as T;
      }
      case 'screenshot': {
        return (await this.screenshot()) as unknown as T;
      }
      case 'snapshot': {
        return (await this.snapshot()) as unknown as T;
      }
      case 'click': {
        if (params.ref) {
          // Click element by reference
          const clickExpr = `(() => {
            const el = document.querySelector('[data-celeste-ref="${params.ref}"]');
            if (!el) return null;
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const rect = el.getBoundingClientRect();
            return {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              tag: el.tagName.toLowerCase(),
              text: (el.innerText || el.textContent || '').trim().slice(0, 30)
            };
          })()`;
          const target = await this.evaluate(clickExpr);
          if (target) {
            await this.click(target.x, target.y);
            return { ok: true, point: { x: target.x, y: target.y }, element: target } as unknown as T;
          }
        }
        const x = typeof params.x === 'number' ? params.x : 100;
        const y = typeof params.y === 'number' ? params.y : 100;
        await this.click(x, y);
        return { ok: true, point: { x, y } } as unknown as T;
      }
      case 'type':
      case 'fill': {
        if (params.ref) {
          await this.evaluate(`(() => {
            const el = document.querySelector('[data-celeste-ref="${params.ref}"]');
            if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
          })()`);
        }
        const text = String(params.text || params.value || '');
        await this.type(text);
        return { ok: true, text } as unknown as T;
      }
      case 'tabs': {
        const pages = await this.listPages();
        return {
          tabs: pages.map((p, idx) => ({
            id: idx + 1,
            title: p.title,
            url: p.url,
            active: idx === 0,
            favIconUrl: p.faviconUrl,
          })),
        } as unknown as T;
      }
      case 'evaluate': {
        const expr = String(params.expression || '');
        const val = await this.evaluate(expr);
        return { value: val } as unknown as T;
      }
      case 'scroll': {
        const dy = typeof params.deltaY === 'number' ? params.deltaY : 300;
        await this.evaluate(`window.scrollBy(0, ${dy})`);
        return { ok: true } as unknown as T;
      }
      default: {
        return { ok: true } as unknown as T;
      }
    }
  }
}
