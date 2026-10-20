/**
 * Extension-local types that are *not* part of the wire protocol.
 */

import type { ProtocolErrorShape } from './protocol.js';

/* -------------------------------------------------------------------------- */
/* Bridge                                                                     */
/* -------------------------------------------------------------------------- */

export type BridgeStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface BridgeState {
  status: BridgeStatus;
  /** TCP port the daemon listens on. */
  port: number;
  /** Fully qualified websocket URL. */
  url: string;
  /** Number of consecutive connection attempts. */
  attempts: number;
  /** Set once a connection has been established. */
  connectedAt?: number;
  /** Last transport level error, if any. */
  lastError?: string;
  /** Round trip time of the most recent heartbeat, in ms. */
  latencyMs?: number;
}

export type BridgeEvent =
  | { type: 'state'; state: BridgeState }
  | { type: 'open'; url: string }
  | { type: 'close'; code: number; reason: string }
  | { type: 'error'; message: string }
  | { type: 'message'; raw: string };

export interface BridgeOptions {
  /** Resolves the daemon port (from `chrome.storage.local`). */
  getPort: () => Promise<number>;
  /** Sink for transport level events. */
  onEvent: (event: BridgeEvent) => void;
  /** Websocket path appended to the host. Defaults to `/extension`. */
  path?: string;
  /** Heartbeat interval in ms. Defaults to 15000. */
  heartbeatMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Content script bridge                                                      */
/* -------------------------------------------------------------------------- */

export const CONTENT_CHANNEL = 'celeste' as const;

export interface ContentRequest {
  channel: typeof CONTENT_CHANNEL;
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ContentResponse {
  channel: typeof CONTENT_CHANNEL;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ProtocolErrorShape;
}

/* -------------------------------------------------------------------------- */
/* Logs                                                                       */
/* -------------------------------------------------------------------------- */

export interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: number;
  url?: string;
  source?: string;
}

export interface DownloadEntry {
  id: number;
  url: string;
  filename: string;
  state: string;
  bytesReceived: number;
  totalBytes: number;
  mime?: string;
  startedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Runtime messaging (popup <-> background)                                   */
/* -------------------------------------------------------------------------- */

export interface StatusResponse {
  ok: boolean;
  state: BridgeState;
  /** Extra diagnostic info for the popup. */
  daemonReachable?: boolean;
  error?: string;
}
