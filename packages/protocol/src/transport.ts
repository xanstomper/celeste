import { PROTOCOL_VERSION } from './types.js';
import type { ClientMessage, ServerMessage } from './types.js';

/**
 * Encodes a client message for transport. JSON is used everywhere so the
 * extension (plain JS) and the daemon (typed TS) agree without a codec.
 */
export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify({ ...message, v: message.v ?? PROTOCOL_VERSION });
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify({ ...message, v: message.v ?? PROTOCOL_VERSION });
}

export function decodeClientMessage(raw: string): ClientMessage {
  const parsed = JSON.parse(raw) as ClientMessage;
  if (!parsed || typeof parsed.type !== 'string') {
    throw new Error('Malformed client message: missing `type`');
  }
  return parsed;
}

export function decodeServerMessage(raw: string): ServerMessage {
  const parsed = JSON.parse(raw) as ServerMessage;
  if (!parsed || typeof parsed.type !== 'string') {
    throw new Error('Malformed server message: missing `type`');
  }
  return parsed;
}

/** Generates a short, collision-resistant identifier. */
export function createId(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const stamp = Date.now().toString(36);
  return prefix ? `${prefix}_${stamp}${rand}` : `${stamp}${rand}`;
}
