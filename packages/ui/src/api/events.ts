/**
 * Event stream plumbing.
 *
 * The daemon exposes two channels: a per-session SSE endpoint and a global
 * websocket. Both deliver the same {@link DaemonEvent} payloads, so the UI
 * subscribes to both and de-duplicates by event fingerprint.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { DaemonEvent } from '@celeste/protocol';

import type { DaemonTransport } from './client';

/**
 * Builds a stable fingerprint for an event so the same frame delivered over
 * SSE *and* the websocket is only applied once.
 */
export function eventFingerprint(event: DaemonEvent): string {
  switch (event.type) {
    case 'task.tool.start':
    case 'task.tool.end':
      return `${event.type}:${event.taskId}:${event.callId}`;
    case 'task.approval':
      return `${event.type}:${event.taskId}:${event.request.id}`;
    case 'task.artifact':
      return `${event.type}:${event.taskId}:${event.artifact.path}:${event.at}`;
    case 'task.message':
      return `${event.type}:${event.taskId}:${event.at}:${event.message.role}:${event.message.content
        .toString()
        .slice(0, 120)}`;
    case 'task.plan':
      return `${event.type}:${event.taskId}:${event.at}`;
    default:
      return `${event.type}:${event.at}:${'taskId' in event ? event.taskId : ''}`;
  }
}

/**
 * A bounded "recently seen" set used to drop duplicate frames.
 */
export class EventDeduper {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly limit: number;

  constructor(limit = 800) {
    this.limit = limit;
  }

  accept(event: DaemonEvent): boolean {
    const key = eventFingerprint(event);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.order.push(key);
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  clear(): void {
    this.seen.clear();
    this.order.length = 0;
  }
}

/** Keeps a callback in a ref so effects do not re-subscribe on every render. */
function useStableCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const ref = useRef(callback);
  useEffect(() => {
    ref.current = callback;
  });
  return useCallback(((...args: never[]) => ref.current(...args)) as unknown as T, []);
}

/**
 * Subscribes to the event stream of a single session.
 */
export function useSessionEvents(
  transport: DaemonTransport | null,
  sessionId: string | null,
  onEvent: (event: DaemonEvent) => void,
): void {
  const stable = useStableCallback(onEvent);

  useEffect(() => {
    if (!transport || !sessionId) return;
    const unsubscribe = transport.subscribe(sessionId, (event) => {
      stable(event);
    });
    return unsubscribe;
  }, [transport, sessionId, stable]);
}

/**
 * Subscribes to the global websocket stream (all sessions).
 */
export function useGlobalEvents(
  transport: DaemonTransport | null,
  onEvent: (event: DaemonEvent) => void,
): void {
  const stable = useStableCallback(onEvent);

  useEffect(() => {
    if (!transport) return;
    const unsubscribe = transport.subscribeGlobal((event) => {
      stable(event);
    });
    return unsubscribe;
  }, [transport, stable]);
}
