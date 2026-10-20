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

export interface BridgeOptions {
  port: number;
  host?: string;
  /** Default timeout for a browser command. */
  timeoutMs?: number;
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
  private connectedAt = 0;
  private lastSeenAt = 0;
  private clientMeta: { version?: string; userAgent?: string } = {};

  constructor(private readonly options: BridgeOptions) {
    super();
  }

  get isConnected(): boolean {
    return this.client?.readyState === WebSocket.OPEN;
  }

  get info(): BrowserClientInfo | null {
    if (!this.clientId) return null;
    return {
      id: this.clientId,
      connectedAt: this.connectedAt,
      lastSeenAt: this.lastSeenAt,
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
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CelesteError('NETWORK_ERROR', 'Browser bridge stopped'));
    }
    this.pending.clear();

    if (this.client) {
      const socket = this.client;
      this.client = null;
      this.clientId = null;
      // `close()` waits for the peer's FIN, which a wedged extension may never
      // send. `terminate()` is immediate, so the server can actually shut down.
      try {
        socket.terminate();
      } catch {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    }

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
    // Only one extension may control the browser at a time.
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      socket.close(4000, 'Another extension is already connected');
      return;
    }

    this.client = socket;
    this.clientId = createId('ext');
    this.connectedAt = Date.now();
    this.lastSeenAt = Date.now();
    this.emit('status', { connected: true, detail: 'extension connected' });

    socket.on('message', (raw) => this.handleMessage(raw.toString()));
    socket.on('close', () => {
      if (this.client === socket) {
        this.client = null;
        this.clientId = null;
        this.failAllPending('Extension disconnected');
        this.emit('status', { connected: false, detail: 'extension disconnected' });
      }
    });
    socket.on('error', () => {
      /* surfaced through close */
    });
  }

  private handleMessage(raw: string): void {
    this.lastSeenAt = Date.now();
    let message;
    try {
      message = decodeClientMessage(raw);
    } catch {
      return;
    }

    switch (message.type) {
      case 'hello': {
        const payload = (message.payload ?? {}) as { version?: string; userAgent?: string };
        this.clientMeta = { version: payload.version, userAgent: payload.userAgent };
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
    if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(encodeServerMessage(message as never));
  }

  /** Sends a raw event to the extension (used for approvals etc.). */
  sendEvent(type: string, payload: unknown): void {
    this.sendRaw({ v: PROTOCOL_VERSION, type, payload });
  }
}
