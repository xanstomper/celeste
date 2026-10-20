import { EventEmitter } from 'node:events';
import type { DaemonEvent } from '@celeste/protocol';

/**
 * Central event bus.
 *
 * Everything the daemon does — a tool starting, a plan changing, a file being
 * written — is emitted here, and the HTTP/SSE/WebSocket layers fan it out to
 * any number of subscribers. Keeping this decoupled means the UI can subscribe
 * to one session or to everything.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A dashboard may legitimately have many concurrent listeners.
    this.emitter.setMaxListeners(200);
  }

  publish(event: DaemonEvent): void {
    this.emitter.emit('event', event);
    this.emitter.emit(`event:${event.type}`, event);
    if ('taskId' in event && event.taskId) {
      this.emitter.emit(`task:${event.taskId}`, event);
    }
  }

  /** Subscribes to every event. Returns an unsubscribe function. */
  subscribe(listener: (event: DaemonEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /** Subscribes to a single event type. */
  on<T extends DaemonEvent['type']>(
    type: T,
    listener: (event: Extract<DaemonEvent, { type: T }>) => void,
  ): () => void {
    const channel = `event:${type}`;
    this.emitter.on(channel, listener as (event: DaemonEvent) => void);
    return () => this.emitter.off(channel, listener as (event: DaemonEvent) => void);
  }

  /** Subscribes to every event belonging to a single task. */
  onTask(taskId: string, listener: (event: DaemonEvent) => void): () => void {
    const channel = `task:${taskId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  removeAll(): void {
    this.emitter.removeAllListeners();
  }
}
