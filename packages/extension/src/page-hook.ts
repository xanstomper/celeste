/**
 * Celeste page hook — runs in the **page** (MAIN) world.
 *
 * The isolated content script cannot observe `fetch` / `XMLHttpRequest` calls
 * because it has its own JavaScript realm. This hook therefore lives in the
 * page world (see `public/manifest.json`, `"world": "MAIN"`) and reports what
 * it sees back to the extension through `window.postMessage`, which *does*
 * cross the isolated-world boundary.
 *
 * It deliberately touches nothing else: no DOM reads, no global mutation
 * beyond the `fetch` / `XHR` / `console` wrappers, and everything is
 * best-effort so a hostile page cannot break the page by throwing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

(() => {
  const globals = window as unknown as Record<string, any>;
  if (globals['__celestePageHook']) return;
  globals['__celestePageHook'] = true;

  const MAX_ENTRIES = 300;
  const MAX_BODY_CHARS = 65_536;

  const network: any[] = (globals['__celesteNetwork'] as any[]) ?? [];
  globals['__celesteNetwork'] = network;

  const consoleEntries: any[] = (globals['__celesteConsole'] as any[]) ?? [];
  globals['__celesteConsole'] = consoleEntries;

  const PAGE_SOURCE = 'celeste-page';
  const CELESTE_SOURCE = 'celeste';

  function post(type: string, payload: unknown): void {
    try {
      window.postMessage({ source: PAGE_SOURCE, type, payload }, '*');
    } catch {
      /* ignore */
    }
  }

  function push(list: any[], entry: any): void {
    list.push(entry);
    while (list.length > MAX_ENTRIES) list.shift();
  }

  function stringify(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }

  function isJsonBody(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const first = trimmed[0];
    if (first !== '{' && first !== '[') return false;
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  function headersToObject(headers: Headers | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!headers) return out;
    try {
      headers.forEach((value: string, key: string) => {
        out[key] = value.length > 500 ? `${value.slice(0, 500)}…` : value;
      });
    } catch {
      /* ignore */
    }
    return out;
  }

  let counter = 0;
  function nextId(): string {
    counter += 1;
    return `n${counter}_${Date.now().toString(36)}`;
  }

  function record(entry: Record<string, unknown>): void {
    push(network, { id: nextId(), timestamp: Date.now(), ...entry });
  }

  /* ---------------------------------------------------------------------- */
  /* fetch                                                                   */
  /* ---------------------------------------------------------------------- */

  const originalFetch: typeof window.fetch | undefined = globals['fetch'];
  if (typeof originalFetch === 'function') {
    globals['fetch'] = async function patchedFetch(this: unknown, ...args: any[]): Promise<Response> {
      const input = args[0];
      const init = args[1] as RequestInit | undefined;
      let method = 'GET';
      let url = '';
      try {
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.toString();
        else if (input && typeof input === 'object') {
          const request = input as Request;
          url = request.url ?? '';
          method = request.method ?? 'GET';
        }
        if (init?.method) method = String(init.method);
      } catch {
        /* ignore */
      }

      try {
        const response: Response = await originalFetch.apply(this, args as any);
        try {
          const contentType = response.headers?.get?.('content-type') ?? '';
          const base = {
            url: response.url || url,
            method: String(method).toUpperCase(),
            resourceType: 'fetch',
            status: response.status,
            headers: headersToObject(response.headers),
          };
          if (!contentType || /json|text|xml|javascript|form-urlencoded/i.test(contentType)) {
            let body = '';
            try {
              body = await response.clone().text();
            } catch {
              body = '';
            }
            record({
              ...base,
              body: body ? body.slice(0, MAX_BODY_CHARS) : undefined,
              isJson: isJsonBody(body),
            });
          } else {
            record({ ...base, isJson: false });
          }
        } catch {
          /* ignore */
        }
        return response;
      } catch (err) {
        record({
          url,
          method: String(method).toUpperCase(),
          resourceType: 'fetch',
          status: 0,
          error: stringify(err),
          isJson: false,
        });
        throw err;
      }
    };
  }

  /* ---------------------------------------------------------------------- */
  /* XMLHttpRequest                                                          */
  /* ---------------------------------------------------------------------- */

  const XHR = globals['XMLHttpRequest'];
  if (XHR && XHR.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function patchedOpen(this: any, method: string, url: string, ...rest: any[]): void {
      this['__celesteMeta'] = { method: String(method ?? 'GET').toUpperCase(), url: String(url ?? '') };
      return originalOpen.apply(this, [method, url, ...rest] as any);
    };

    XHR.prototype.send = function patchedSend(this: any, body?: any): void {
      const meta = this['__celesteMeta'] ?? { method: 'GET', url: '' };
      try {
        this.addEventListener('loadend', () => {
          let text = '';
          try {
            if (!this.responseType || this.responseType === 'text') text = this.responseText ?? '';
          } catch {
            text = '';
          }
          let requestBody: string | undefined;
          try {
            if (typeof body === 'string') requestBody = body.slice(0, MAX_BODY_CHARS);
          } catch {
            requestBody = undefined;
          }
          record({
            url: meta.url,
            method: meta.method,
            resourceType: 'xhr',
            status: this.status ?? 0,
            headers: headersToObject(
              (() => {
                try {
                  const raw = this.getAllResponseHeaders?.();
                  if (!raw) return undefined;
                  const out: Record<string, string> = {};
                  for (const line of String(raw).trim().split(/[\r\n]+/)) {
                    const index = line.indexOf(':');
                    if (index <= 0) continue;
                    out[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
                  }
                  return new Headers(out);
                } catch {
                  return undefined;
                }
              })(),
            ),
            body: requestBody ?? (text ? text.slice(0, MAX_BODY_CHARS) : undefined),
            isJson: isJsonBody(text),
          });
        });
      } catch {
        /* ignore */
      }
      return originalSend.apply(this, [body] as any);
    };
  }

  /* ---------------------------------------------------------------------- */
  /* console                                                                 */
  /* ---------------------------------------------------------------------- */

  const consoleObject = globals['console'];
  if (consoleObject) {
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    for (const method of methods) {
      const original = consoleObject[method];
      if (typeof original !== 'function') continue;
      consoleObject[method] = function patchedConsole(this: unknown, ...args: any[]): void {
        try {
          push(consoleEntries, {
            level: method,
            text: args.map(stringify).join(' '),
            timestamp: Date.now(),
            url: location.href,
          });
          post('console', {
            level: method,
            text: args.map(stringify).join(' '),
            timestamp: Date.now(),
            url: location.href,
          });
        } catch {
          /* ignore */
        }
        return original.apply(this, args as any);
      };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Sync protocol                                                            */
  /* ---------------------------------------------------------------------- */

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; type?: string } | undefined;
    if (!data || data.source !== CELESTE_SOURCE) return;
    if (data.type === 'sync-request') {
      post('sync-response', { network: network.slice(), console: consoleEntries.slice() });
    }
  });
})();
