/**
 * Websocket transport to the Celeste daemon.
 *
 * The daemon runs on the user's machine and cannot reach into the browser, so
 * the extension dials *out* to `ws://127.0.0.1:<port>/extension`. The bridge
 * owns:
 *
 *  - connection lifecycle (connect / reconnect with jittered backoff)
 *  - a `ping`/`pong` heartbeat so a half-open socket is detected quickly
 *  - an event sink the background worker subscribes to
 *
 * It deliberately knows nothing about browser commands — that is the
 * dispatcher's job.
 */

import type { BridgeEvent, BridgeOptions, BridgeState } from './types.js';

const DEFAULT_PATH = '/extension';
const DEFAULT_HEARTBEAT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;
/** Force a reconnect if the socket has been silent for this long. */
const STALE_SOCKET_MS = 45_000;

export class Bridge {
  private socket: WebSocket | null = null;
  private attempts = 0;
  private connectedAt: number | undefined;
  private lastError: string | undefined;
  private latencyMs: number | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private currentPort = 0;
  private status: BridgeState['status'] = 'idle';

  constructor(private readonly options: BridgeOptions) {}

  /* ---------------------------------------------------------------------- */
  /* Public API                                                             */
  /* ---------------------------------------------------------------------- */

  /** Current transport state (safe to serialise into the popup). */
  getState(): BridgeState {
    const port = this.currentPort;
    return {
      status: this.socket && this.socket.readyState === WebSocket.OPEN ? 'connected' : this.status,
      port,
      url: port ? `ws://127.0.0.1:${port}${this.options.path ?? DEFAULT_PATH}` : '',
      attempts: this.attempts,
      ...(this.connectedAt !== undefined ? { connectedAt: this.connectedAt } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      ...(this.latencyMs !== undefined ? { latencyMs: this.latencyMs } : {}),
    };
  }

  /** Starts (or restarts) the connection loop. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /** Stops the connection loop and tears down the socket. */
  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, 'extension stopped');
      } catch {
        /* ignore */
      }
    }
    this.emitState();
  }

  /** Ensures a connection exists (used by the keep-alive alarm). */
  async ensureConnected(): Promise<void> {
    if (this.stopped) {
      await this.start();
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.clearReconnectTimer();
    await this.connect();
  }

  /**
   * Sends a raw frame. Returns false when the socket is not open — callers
   * are expected to queue the payload themselves.
   */
  send(raw: string): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(raw);
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emitState();
      return false;
    }
  }

  /** True when the socket is currently usable. */
  get isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.clearReconnectTimer();

    let port = 0;
    try {
      port = await this.options.getPort();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
      return;
    }

    if (!port) {
      this.lastError = 'invalid bridge port';
      this.scheduleReconnect();
      return;
    }

    this.currentPort = port;
    const path = this.options.path ?? DEFAULT_PATH;
    const url = `ws://127.0.0.1:${port}${path}`;

    this.attempts += 1;
    this.status = 'connecting';
    this.emitState();

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.status = 'error';
      this.emitState();
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.connectedAt = Date.now();
      this.lastError = undefined;
      this.status = 'connected';
      this.emitState();
      this.options.onEvent({ type: 'open', url });
      this.startHeartbeat();
    };

    socket.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '');
      this.latencyMs = undefined;
      this.options.onEvent({ type: 'message', raw });
    };

    socket.onerror = () => {
      // `onerror` is always followed by `onclose`; record and let close handle
      // the reconnect so we do not double-schedule.
      this.lastError = 'websocket error';
      this.status = 'error';
      this.emitState();
      this.options.onEvent({ type: 'error', message: 'websocket error' });
    };

    socket.onclose = (event: CloseEvent) => {
      this.clearHeartbeat();
      if (this.socket === socket) this.socket = null;
      this.status = 'disconnected';
      this.emitState();
      this.options.onEvent({
        type: 'close',
        code: typeof event.code === 'number' ? event.code : 1006,
        reason: typeof event.reason === 'string' ? event.reason : '',
      });
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const interval = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (this.connectedAt !== undefined && now - this.connectedAt > STALE_SOCKET_MS && this.latencyMs === undefined) {
        // The socket never answered a single ping — treat it as half open.
        try {
          socket.close(4000, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        socket.send(JSON.stringify({ v: '1.0.0', type: 'ping' }));
      } catch {
        /* ignore */
      }
    }, interval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(this.attempts, 10));
    // Full jitter keeps a fleet of extensions from stampeding the daemon.
    const delay = Math.round(exponential * (0.5 + Math.random() * 0.75));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private emitState(): void {
    this.options.onEvent({ type: 'state', state: this.getState() });
  }
}
