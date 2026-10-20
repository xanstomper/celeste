import { describe, expect, it } from 'vitest';
import {
  BROWSER_ACTIONS,
  PROTOCOL_VERSION,
  createId,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
} from '../src/index.js';

describe('transport', () => {
  it('round-trips a client message', () => {
    const message = { type: 'hello', payload: { version: '1.0.0' } };
    const encoded = encodeClientMessage(message);
    const decoded = decodeClientMessage(encoded);
    expect(decoded.type).toBe('hello');
    expect(decoded.v).toBe(PROTOCOL_VERSION);
    expect(decoded.payload).toEqual({ version: '1.0.0' });
  });

  it('round-trips a server message', () => {
    const encoded = encodeServerMessage({ type: 'welcome', payload: { accepted: true } });
    const decoded = decodeServerMessage(encoded);
    expect(decoded.type).toBe('welcome');
  });

  it('rejects malformed messages', () => {
    expect(() => decodeClientMessage('{not json')).toThrow();
    expect(() => decodeClientMessage('{"no":"type"}')).toThrow();
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => createId('x')));
    expect(ids.size).toBe(500);
  });
});

describe('browser action registry', () => {
  it('covers every documented verb', () => {
    for (const action of [
      'navigate',
      'snapshot',
      'click',
      'type',
      'extract',
      'screenshot',
      'network',
      'tabs',
      'challenge',
      'console',
    ]) {
      expect(BROWSER_ACTIONS).toContain(action);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(BROWSER_ACTIONS).size).toBe(BROWSER_ACTIONS.length);
  });
});
