/**
 * Typed client for the Celeste daemon HTTP + WebSocket surface.
 *
 * Every route here is derived from the canonical {@link API_ROUTES} table that
 * lives in `@celeste/protocol`, so the client and the daemon can never drift.
 */

import { API_ROUTES } from '@celeste/protocol';
import type {
  ApprovalResponseRequest,
  ArtifactListResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  DaemonEvent,
  ErrorResponse,
  HealthResponse,
  ProviderSummary,
  ProviderSwitchRequest,
  ProviderSwitchResponse,
  SessionDetailResponse,
  SessionListResponse,
  TaskState,
} from '@celeste/protocol';

export const DEFAULT_API_BASE = 'http://127.0.0.1:9126';

/** Reads `VITE_CELESTE_API`; falls back to the well known local daemon. */
export function readEnvApiBase(): string {
  const raw = import.meta.env.VITE_CELESTE_API;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return DEFAULT_API_BASE;
  return value.replace(/\/+$/, '');
}

/** Turns an http(s) base into the daemon websocket endpoint. */
export function resolveWsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (/^wss?:\/\//i.test(trimmed)) return `${trimmed}${API_ROUTES.websocket}`;
  try {
    const url = new URL(trimmed || DEFAULT_API_BASE);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = API_ROUTES.websocket;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return `ws://${trimmed}${API_ROUTES.websocket}`;
  }
}

/** An error raised by the daemon (or by the network in between). */
export class DaemonApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = 'DaemonApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function request<T>(base: string, path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, timeoutMs = 10_000 } = options;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'request timed out' : 'network error';
    throw new DaemonApiError(`Celeste daemon unreachable (${reason})`, 0, 'NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const text = await response.text();
  let payload: unknown;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    const err = payload as ErrorResponse | undefined;
    const message = err?.error ?? `${response.status} ${response.statusText}`;
    throw new DaemonApiError(message, response.status, err?.code);
  }

  return payload as T;
}

/**
 * Normalises an arbitrary thrown value into a `DaemonApiError`.
 */
export function toApiError(err: unknown): DaemonApiError {
  if (err instanceof DaemonApiError) return err;
  if (err instanceof Error) return new DaemonApiError(err.message, 0, 'INTERNAL');
  return new DaemonApiError('Unknown error', 0, 'INTERNAL');
}

/* -------------------------------------------------------------------------- */
/* Transport contract                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The surface the UI needs from a daemon. Implemented twice: once against the
 * real HTTP/SSE daemon (`HttpTransport`) and once by the in-browser mock
 * (`MockTransport`), so the UI can render without a running daemon.
 */
export interface DaemonTransport {
  readonly kind: 'live' | 'mock';
  health(): Promise<HealthResponse>;
  listProviders(): Promise<ProviderSummary[]>;
  switchProvider(id: string): Promise<ProviderSummary>;
  listSessions(): Promise<TaskState[]>;
  createSession(request: CreateSessionRequest): Promise<TaskState>;
  getSession(id: string): Promise<TaskState>;
  approve(id: string, request: ApprovalResponseRequest): Promise<void>;
  cancel(id: string): Promise<void>;
  sendMessage(id: string, content: string): Promise<void>;
  listArtifacts(): Promise<ArtifactListResponse['artifacts']>;
  /** Subscribe to the event stream of a single session. */
  subscribe(sessionId: string, onEvent: (event: DaemonEvent) => void): () => void;
  /** Subscribe to every event the daemon emits (used by the websocket). */
  subscribeGlobal(onEvent: (event: DaemonEvent) => void, onReconnect?: () => void): () => void;
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Live HTTP transport                                                         */
/* -------------------------------------------------------------------------- */

export class HttpTransport implements DaemonTransport {
  readonly kind = 'live' as const;
  private readonly base: string;
  private disposed = false;

  constructor(base: string) {
    this.base = base.replace(/\/+$/, '');
  }

  get apiBase(): string {
    return this.base;
  }

  health(): Promise<HealthResponse> {
    return request<HealthResponse>(this.base, API_ROUTES.health, { timeoutMs: 4_000 });
  }

  async listProviders(): Promise<ProviderSummary[]> {
    const payload = await request<{ providers: ProviderSummary[] }>(this.base, API_ROUTES.providers);
    return payload.providers ?? [];
  }

  async switchProvider(id: string): Promise<ProviderSummary> {
    const body: ProviderSwitchRequest = { id };
    const payload = await request<ProviderSwitchResponse>(this.base, API_ROUTES.providerActive, {
      method: 'POST',
      body,
    });
    return payload.active;
  }

  async listSessions(): Promise<TaskState[]> {
    const payload = await request<SessionListResponse>(this.base, API_ROUTES.sessions);
    return payload.tasks ?? [];
  }

  async createSession(requestBody: CreateSessionRequest): Promise<TaskState> {
    const payload = await request<CreateSessionResponse>(this.base, API_ROUTES.sessions, {
      method: 'POST',
      body: requestBody,
    });
    return payload.task;
  }

  async getSession(id: string): Promise<TaskState> {
    const payload = await request<SessionDetailResponse>(this.base, API_ROUTES.session(id));
    return payload.task;
  }

  async approve(id: string, body: ApprovalResponseRequest): Promise<void> {
    await request<{ ok: true }>(this.base, API_ROUTES.sessionApprove(id), {
      method: 'POST',
      body,
    });
  }

  async cancel(id: string): Promise<void> {
    await request<{ ok: true }>(this.base, API_ROUTES.sessionCancel(id), { method: 'POST' });
  }

  async sendMessage(id: string, content: string): Promise<void> {
    await request<{ ok: true }>(this.base, API_ROUTES.sessionSend(id), {
      method: 'POST',
      body: { content },
    });
  }

  async listArtifacts(): Promise<ArtifactListResponse['artifacts']> {
    const payload = await request<ArtifactListResponse>(this.base, API_ROUTES.artifacts);
    return payload.artifacts ?? [];
  }

  /**
   * Subscribes to `/api/sessions/:id/events`.
   *
   * The daemon may frame the stream as SSE (`data: {...}`) or as plain
   * newline-delimited JSON. `EventSource` handles the SSE case; if it fails
   * we transparently downgrade to a `fetch` stream that splits on newlines.
   */
  subscribe(sessionId: string, onEvent: (event: DaemonEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    let closed = false;
    let source: EventSource | null = null;
    let abort: AbortController | null = null;
    let fellBack = false;

    const handle = (raw: string) => {
      const data = raw.trim();
      if (!data || data.startsWith(':')) return;
      try {
        onEvent(JSON.parse(data) as DaemonEvent);
      } catch {
        /* ignore malformed frames */
      }
    };

    const startFallback = () => {
      if (closed || fellBack) return;
      fellBack = true;
      source?.close();
      source = null;
      abort = new AbortController();
      void (async () => {
        try {
          const response = await fetch(`${this.base}${API_ROUTES.sessionEvents(sessionId)}`, {
            headers: { accept: 'application/x-ndjson, text/event-stream' },
            signal: abort.signal,
          });
          if (!response.ok || !response.body) return;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              if (trimmed.startsWith('data:')) handle(trimmed.slice(5).trim());
              else handle(trimmed);
            }
          }
        } catch {
          /* stream aborted or daemon gone */
        }
      })();
    };

    try {
      source = new EventSource(`${this.base}${API_ROUTES.sessionEvents(sessionId)}`);
      source.onmessage = (ev) => handle(ev.data);
      source.onerror = () => {
        if (closed) return;
        // EventSource retries on its own; if the endpoint is not SSE at all
        // we fall back to a raw NDJSON stream.
        if (source?.readyState === EventSource.CLOSED) startFallback();
      };
    } catch {
      startFallback();
    }

    return () => {
      closed = true;
      source?.close();
      abort?.abort();
    };
  }

  /**
   * Subscribes to the global `/ws` websocket stream.
   *
   * The daemon is a local process that gets restarted — during a rebuild, or
   * by the user. A socket that closes must not leave the panel frozen on old
   * data, so it reconnects with a short backoff and reports each (re)connect.
   */
  subscribeGlobal(
    onEvent: (event: DaemonEvent) => void,
    onReconnect?: () => void,
  ): () => void {
    if (this.disposed) return () => undefined;

    let socket: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      if (closed || this.disposed) return;
      try {
        socket = new WebSocket(resolveWsUrl(this.base));
      } catch {
        schedule();
        return;
      }

      socket.onopen = () => {
        const reconnected = attempt > 0;
        attempt = 0;
        if (reconnected) onReconnect?.();
      };

      socket.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          onEvent(JSON.parse(ev.data) as DaemonEvent);
        } catch {
          /* ignore malformed frames */
        }
      };

      socket.onclose = () => {
        if (closed) return;
        schedule();
      };
      socket.onerror = () => {
        /* `onclose` follows, which is where the retry lives */
      };
    };

    const schedule = (): void => {
      if (closed || this.disposed) return;
      const delay = Math.min(500 * 2 ** attempt, 10_000);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };

    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
    };
  }

  dispose(): void {
    this.disposed = true;
  }
}
