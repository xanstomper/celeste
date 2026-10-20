/**
 * Connection bootstrap.
 *
 * The desktop client must never show a broken screen, so when the daemon
 * cannot be reached we transparently fall back to the built-in mock daemon.
 * The decision lives here (instead of inside the React store) so it can be
 * exercised without a DOM.
 */

import { HttpTransport, readEnvApiBase, toApiError } from './client';
import type { DaemonTransport } from './client';
import { MockTransport } from './mock';

export type ConnectMode = 'auto' | 'live' | 'demo';

export interface ConnectResult {
  transport: DaemonTransport;
  /** `connected` when the real daemon answered, `demo` when we fell back. */
  status: 'connected' | 'demo';
  /** Why the real daemon was unusable (only set in demo mode). */
  error: string | undefined;
}

/**
 * Builds a transport for the requested mode.
 *
 * - `demo` always returns the mock.
 * - `live` prefers the real daemon but still falls back to the mock (the
 *   caller is told why through `error`).
 * - `auto` behaves like `live` and silently falls back.
 */
export async function connectDaemon(options: {
  mode: ConnectMode;
  base?: string;
}): Promise<ConnectResult> {
  const { mode } = options;
  const base = (options.base ?? '').trim() || readEnvApiBase();

  if (mode === 'demo') {
    return { transport: new MockTransport(), status: 'demo', error: undefined };
  }

  const http = new HttpTransport(base);
  try {
    await http.health();
    return { transport: http, status: 'connected', error: undefined };
  } catch (err) {
    http.dispose();
    const error = toApiError(err).message;
    return { transport: new MockTransport(), status: 'demo', error };
  }
}
