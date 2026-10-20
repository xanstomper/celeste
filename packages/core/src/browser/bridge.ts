import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import {
  createId,
  decodeClientMessage,
  encodeServerMessage,
  PROTOCOL_VERSION,
} from '@celeste/protocol';
import type { BrowserCommand, ExtensionEvent, ProtocolErrorShape } from '@celeste/protocol';
import { CelesteError } from '@celeste/protocol';

/** A pending command awaiting its result from the extension. */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
}

/**
 * A connected extension.
 *
 * More than one can be alive: the user may have several browser windows, or
 * a stale instance may still be shutting down. Only one of them serves
 * commands at a time — the one seen most recently — but the others are never
 * terminated, because doing so makes them reconnect and starts a storm.
 */
interface Client {
  id: string;
  socket: WebSocket;
  lastSeenAt: number;
  connectedAt: number;
  workerId?: string;
}

export interface BridgeOptions {
  port: number;
  host?: string;
  /** Default timeout for a browser command. */
  timeoutMs?: number;
  /** How often to ping the extension. */
  heartbeatMs?: number;
  /** How long the extension may stay silent before the socket is dropped. */
  heartbeatTimeoutMs?: number;
}

export interface BrowserClientInfo {
  id: string;
  connectedAt: number;
  lastSeenAt: number;
  version?: string;
  userAgent?: string;
}

/**
 * The browser bridge.
 *
 * Celeste drives a *real* browser, so the extension connects out to this
 * daemon over a loopback WebSocket. This class owns that socket, correlates
 * commands with their results, and republishes extension events onto the
 * daemon's event bus.
 */
export class BrowserBridge extends EventEmitter {
  private server: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private clientId: string | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly clients = new Map<string, Client>();
  private activeId: string | undefined;
  private readonly heartbeat: NodeJS.Timeout;
  private connectedAt = 0;
  private lastSeenAt = 0;
  private clientMeta: { version?: string; userAgent?: string } = {};
  /** Identifies the extension's service-worker instance. */
  private workerId: string | undefined;

  constructor(private readonly options: BridgeOptions) {
    super();
    this.heartbeat = setInterval(() => this.ping(), this.options.heartbeatMs ?? 15_000);
    this.heartbeat.unref?.();
  }

  /**
   * Pings the active extension and drops clients that stop answering.
   *
   * A suspended MV3 worker leaves a socket that looks open but never
   * delivers anything. Without this the daemon would happily report the
   * extension as connected and every command would time out.
   */
  private ping(): void {
    const now = Date.now();
    // Manifest V3 suspends an idle worker, and a suspended worker does not
    // answer pings even though its socket is fine. Give it a long window: a
    // browser that is really gone shows up as a closed socket or a command
    // timeout, not as two missed heartbeats.
    const staleAfter = this.options.heartbeatTimeoutMs ?? 120_000;

    for (const client of [...this.clients.values()]) {
      if (now - client.lastSeenAt <= staleAfter) continue;
      // A worker that is busy running a command is not a dead worker. Killing
      // it mid-command turns a slow page into a failed task, so wait for the
      // command's own timeout to decide.
      if (this.pending.size > 0) continue;
      // No traffic for too long: this socket is dead.
      this.clients.delete(client.id);
      try {
        client.socket.terminate();
      } catch {
        /* ignore */
      }
      this.emit('debug', { event: 'stale', clientId: client.id });
      if (this.activeId === client.id) {
        this.activeId = undefined;
        this.emit('status', { connected: false, detail: 'extension heartbeat missed' });
        this.failAllPending('Extension heartbeat missed');
      }
    }

    const active = this.activeClient();
    if (!active) return;
    this.sendRaw({ v: PROTOCOL_VERSION, type: 'ping', payload: { at: now } });
  }

  /** The client that most recently showed signs of life. */
  private activeClient(): Client | undefined {
    let best: Client | undefined;
    for (const client of this.clients.values()) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (!best || client.lastSeenAt > best.lastSeenAt) best = client;
    }
    return best;
  }

  get isConnected(): boolean {
    return this.activeClient() !== undefined;
  }

  get info(): BrowserClientInfo | null {
    const client = this.activeClient();
    if (!client) return null;
    return {
      id: client.id,
      connectedAt: client.connectedAt,
      lastSeenAt: client.lastSeenAt,
      version: this.clientMeta.version,
      userAgent: this.clientMeta.userAgent,
    };
  }

  /** Starts listening for extension connections. */
  async start(): Promise<void> {
    if (this.server) return;
    const host = this.options.host ?? '127.0.0.1';
    this.server = new WebSocketServer({ host, port: this.options.port });

    this.server.on('connection', (socket) => this.handleConnection(socket));
    // An EventEmitter with no 'error' listener throws when the error is
    // re-emitted, which would take the whole daemon down. Only re-emit when
    // somebody is actually listening; otherwise swallow it here (the
    // `listening` promise below reports the failure to the caller).
    this.server.on('error', (err) => {
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server?.once('error', onError);
      this.server?.once('listening', () => {
        this.server?.off('error', onError);
        resolve();
      });
    });
  }

  /** Stops the bridge and fails every in-flight command. */
  async stop(): Promise<void> {
    clearInterval(this.heartbeat);

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CelesteError('NETWORK_ERROR', 'Browser bridge stopped'));
    }
    this.pending.clear();

    for (const client of this.clients.values()) {
      // `terminate()` is immediate; `close()` waits for the peer's FIN, which
      // a wedged extension may never send.
      try {
        client.socket.terminate();
      } catch {
        try {
          client.socket.close();
        } catch {
          /* ignore */
        }
      }
    }
    this.clients.clear();
    this.activeId = undefined;

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        server.close(() => done());
        // Never let a stuck connection hold the shutdown hostage.
        setTimeout(done, 2000).unref?.();
      });
    }

    this.emit('status', { connected: false });
  }

  private handleConnection(socket: WebSocket): void {
    // Several extensions may be alive at once (multiple browser windows, or an
    // old instance still shutting down). Each gets its own entry; the most
    // recently active one serves commands. Crucially, no healthy client is
    // terminated: doing so makes it reconnect, which starts a storm.
    const client: Client = {
      id: createId('ext'),
      socket,
      lastSeenAt: Date.now(),
      connectedAt: Date.now(),
    };
    this.clients.set(client.id, client);
    this.activeId = client.id;
    this.emit('status', { connected: true, detail: 'extension connected' });
    this.emit('debug', { event: 'connected', clientId: client.id });

    socket.on('message', (raw) => {
      client.lastSeenAt = Date.now();
      this.handleMessage(raw.toString(), client);
    });
    socket.on('close', (code: number, reason: Buffer) => {
      this.clients.delete(client.id);
      this.emit('debug', {
        event: 'close',
        code,
        reason: reason?.toString?.() ?? '',
        clientId: client.id,
        wasActive: this.activeId === client.id,
      });
      if (this.activeId === client.id) {
        this.activeId = undefined;
        this.failAllPending('Extension disconnected');
        this.emit('status', { connected: this.isConnected, detail: 'extension disconnected' });
      }
    });
    socket.on('error', () => {
      /* surfaced through close */
    });
  }

  private handleMessage(raw: string, client: Client): void {
    let message;
    try {
      message = decodeClientMessage(raw);
    } catch {
      return;
    }

    switch (message.type) {
      case 'hello': {
        const payload = (message.payload ?? {}) as {
          version?: string;
          userAgent?: string;
          worker?: string;
          stack?: string;
          state?: unknown;
        };
        this.clientMeta = { version: payload.version, userAgent: payload.userAgent };
        client.workerId = payload.worker;
        this.workerId = payload.worker;
        this.emit('debug', {
          event: 'hello',
          worker: payload.worker ?? 'unknown',
          clientId: client.id,
        });
        this.sendRaw({
          v: PROTOCOL_VERSION,
          type: 'welcome',
          payload: { version: PROTOCOL_VERSION, accepted: true },
        });
        break;
      }

      case 'browser.result': {
        const id = message.id;
        if (!id) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const payload = message.payload as
          | { ok: true; result: unknown }
          | { ok: false; error: ProtocolErrorShape };
        if (payload?.ok) {
          pending.resolve(payload.result);
        } else {
          const err = payload?.error;
          pending.reject(
            new CelesteError(
              (err?.code as never) ?? 'INTERNAL',
              err?.message ?? `Browser command "${pending.action}" failed`,
              { retryable: err?.retryable ?? false, details: err?.details },
            ),
          );
        }
        break;
      }

      case 'event': {
        const event = message.payload as ExtensionEvent;
        if (event) this.emit('extension-event', event);
        break;
      }

      case 'task.request': {
        // The page's "Ask" button asked for work to be started.
        const payload = (message.payload ?? {}) as { prompt?: string; url?: string };
        this.emit('task-request', payload);
        break;
      }

      case 'ping': {
        this.sendRaw({ v: PROTOCOL_VERSION, type: 'pong', payload: { at: Date.now() } });
        break;
      }

      default:
        break;
    }
  }

  /**
   * Sends a command to the browser and awaits the result.
   * Throws a `CelesteError` when the extension is missing or the command
   * times out — both retryable so the agent loop can recover.
   */
  async send<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
    opts: { tabId?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.isConnected) {
      throw new CelesteError(
        'NETWORK_ERROR',
        'No browser extension is connected. Install the Celeste extension and reload it.',
        { retryable: true },
      );
    }

    const id = createId('cmd');
    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    const command: BrowserCommand = {
      action,
      params,
      ...(opts.tabId !== undefined ? { tabId: opts.tabId } : {}),
      timeoutMs,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CelesteError('TIMEOUT', `Browser command "${action}" timed out after ${timeoutMs}ms`, {
            retryable: true,
          }),
        );
      }, timeoutMs + 2000);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        action,
      });

      this.sendRaw({ v: PROTOCOL_VERSION, type: 'browser.command', id, payload: command });
    });
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CelesteError('NETWORK_ERROR', reason, { retryable: true }));
    }
    this.pending.clear();
  }

  private sendRaw(message: { v: string; type: string; id?: string; payload?: unknown }): void {
    const client = this.activeClient();
    if (!client) return;
    client.socket.send(encodeServerMessage(message as never));
  }

  /** Sends a raw event to the extension (used for approvals etc.). */
  sendEvent(type: string, payload: unknown): void {
    this.sendRaw({ v: PROTOCOL_VERSION, type, payload });
  }
}
