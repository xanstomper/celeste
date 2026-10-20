import { ProviderError } from './types.js';

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
  json<T = unknown>(): T;
}

/**
 * Thin `fetch` wrapper with timeout + normalised error handling.
 * Node 20+ ships a global fetch, so no extra dependency is required.
 */
export async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? 120_000;

  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  const onOuterAbort = () => controller.abort(req.signal?.reason);
  if (req.signal) {
    if (req.signal.aborted) controller.abort(req.signal.reason);
    else req.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method ?? (req.body !== undefined ? 'POST' : 'GET'),
      headers: {
        'content-type': 'application/json',
        ...(req.headers ?? {}),
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    throw new ProviderError('http', aborted ? 'Request aborted or timed out' : String(err), {
      retryable: true,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onOuterAbort);
  }

  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return {
    status: res.status,
    ok: res.ok,
    headers,
    text,
    json<T = unknown>(): T {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ProviderError('http', `Expected JSON but got: ${text.slice(0, 300)}`);
      }
    },
  };
}

/**
 * Retries a request with exponential backoff. Only retries when the error is
 * explicitly marked retryable (network blips, 429, 5xx).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelay = options.baseDelayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ProviderError ? err.retryable : false;
      if (!retryable || attempt === attempts - 1) break;

      // A provider that tells us when to come back is more useful than one
      // that just refuses. Cap the wait: a task should not hang for minutes.
      const requested = err instanceof ProviderError ? err.retryAfterMs : undefined;
      const delay =
        requested !== undefined
          ? Math.min(requested + 250, 45_000)
          : baseDelay * 2 ** attempt + Math.random() * 250;
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
