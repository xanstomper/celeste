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
/**
 * Identifies this service-worker instance. If the daemon sees the id change
 * between connections, the worker was evicted and restarted rather than the
 * socket merely dropping.
 */
const WORKER_INSTANCE_ID = Math.random().toString(36).slice(2, 10);

export { WORKER_INSTANCE_ID };
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;
/** Force a reconnect if the socket has been silent for this long. */

export class Bridge {
  private socket: WebSocket | null = null;
  private attempts = 0;
  private connectedAt: number | undefined;
  private lastError: string | undefined;
  private latencyMs: number | undefined;
  /** When the last ping went out, so a pong can be turned into a round-trip. */
  private pingSentAt: number | undefined;
  /** When the daemon last proved it was listening. */
  private lastPongAt: number | undefined;
  private connecting = false;
  /** Stack of the most recent connect() call, for diagnosing loops. */
  private lastConnectStack = '';
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
      ...(this.lastPongAt !== undefined ? { lastPongAgoMs: Date.now() - this.lastPongAt } : {}),
      ...(this.pingSentAt !== undefined ? { pingOutstandingMs: Date.now() - this.pingSentAt } : {}),
    };
  }

  /** The stack of the most recent connect() call, for diagnosing loops. */
  getConnectStack(): string {
    return this.lastConnectStack;
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
    // Guard against overlapping attempts: a socket that is still handshaking
    // counts as "already connecting". Without this, two callers can each open
    // a socket, and the loser closes the winner mid-handshake.
    if (this.connecting) return;
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
    if (this.connecting) return;
    this.connecting = true;
    this.clearReconnectTimer();
    // Captured so a connection loop can be traced to its caller.
    this.lastConnectStack = new Error('connect()').stack ?? '';

    try {
      await this.doConnect();
    } finally {
      this.connecting = false;
    }
  }

  private async doConnect(): Promise<void> {
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

    // Retire a socket that is still established. A socket that is merely
    // handshaking is left alone: closing it mid-handshake produces a noisy
    // "closed before the connection is established" failure.
    const previous = this.socket;
    if (previous && previous !== socket && previous.readyState === WebSocket.OPEN) {
      try {
        previous.close(1000, 'superseded');
      } catch {
        /* ignore */
      }
    }

    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.connectedAt = Date.now();
      this.latencyMs = undefined;
      this.pingSentAt = undefined;
      // Grace period: the link is fresh, nothing has gone unanswered yet.
      this.lastPongAt = Date.now();
      this.lastError = undefined;
      this.status = 'connected';
      this.emitState();
      this.options.onEvent({ type: 'open', url });
      this.startHeartbeat();
    };

    socket.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '');
      // A pong is proof that the link is alive in both directions. Recording
      // it is what lets the heartbeat tell a healthy idle socket from a
      // half-open one; without it the socket was closed every forty-five
      // seconds, mid-task, and commands failed with "receiving end does not
      // exist".
      if (raw.includes('"pong"')) {
        const now = Date.now();
        this.latencyMs = this.pingSentAt !== undefined ? now - this.pingSentAt : 0;
        this.pingSentAt = undefined;
        this.lastPongAt = now;
      }
      this.options.onEvent({ type: 'message', raw });
    };

    socket.onerror = () => {
      // `onerror` is always followed by `onclose`; record and let close handle
      // the reconnect so we do not double-schedule.
      this.lastError = 'websocket error';
      this.status = 'error';
      this.emitState();
      this.options.onEvent({
        type: 'error',
        message: `websocket error (${this.lastError}) url=${url} attempts=${this.attempts} state=${this.getState().status}`,
      });
    };

    socket.onclose = (event: CloseEvent) => {
      // A *superseded* socket closing must not disturb the live one. The
      // daemon replaces the old socket when the service worker restarts, and
      // reacting to that close by reconnecting would start a loop: new socket
      // -> old terminated -> old closes -> reconnect -> ...
      if (this.socket !== socket) return;

      this.clearHeartbeat();
      this.socket = null;
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

    const tick = (): void => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();

      // Ping, but never hang up on a quiet link. A service worker is suspended
      // between ticks, so a long gap proves nothing; and the daemon already
      // drops a client it cannot reach. Closing from here only produced a
      // reconnect storm every forty-five seconds, mid-task.
      try {
        this.pingSentAt = now;
        socket.send(JSON.stringify({ v: '1.0.0', type: 'ping' }));
      } catch {
        /* ignore */
      }
    };

    // Prove the link immediately rather than waiting a full interval.
    tick();
    this.heartbeatTimer = setInterval(tick, interval);
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
