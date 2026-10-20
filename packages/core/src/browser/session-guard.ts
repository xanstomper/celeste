import type { ExtensionEvent } from '@celeste/protocol';
import { EventEmitter } from 'node:events';

export type SessionHealth = 'ok' | 'challenge' | 'expired' | 'unknown';

export interface SessionStatus {
  health: SessionHealth;
  /** Human readable explanation of the current state. */
  detail?: string;
  /** When the state was last updated. */
  at: number;
  /** Tab id the problem was detected on, when known. */
  tabId?: number;
}

/**
 * Session Health Guard.
 *
 * Commercial browser agents fail on real-world tasks because they operate in a
 * sterile, logged-out window. Celeste operates *your* browser — which means
 * it inherits your sessions, but also inherits their expiry. This guard
 * watches for the moment a site logs you out, and pauses the agent so the
 * user can re-authenticate instead of the agent flailing against a login wall.
 */
export class SessionGuard extends EventEmitter {
  private status: SessionStatus = { health: 'ok', at: Date.now() };
  private readonly history: SessionStatus[] = [];

  get current(): SessionStatus {
    return this.status;
  }

  get recent(): SessionStatus[] {
    return this.history.slice(-50);
  }

  /** True when the agent should stop and wait for a human. */
  get blocked(): boolean {
    return this.status.health === 'challenge' || this.status.health === 'expired';
  }

  /**
   * Feeds an extension event into the guard.
   * Returns the new status when it changed, otherwise `null`.
   */
  ingest(event: ExtensionEvent): SessionStatus | null {
    switch (event.type) {
      case 'challenge.detected': {
        const payload = (event.payload ?? {}) as { kind?: string; confidence?: number };
        return this.transition('challenge', `Verification challenge detected${payload.kind ? ` (${payload.kind})` : ''}. Human intervention required.`);
      }
      case 'session.expired': {
        const payload = (event.payload ?? {}) as { url?: string; reason?: string };
        return this.transition('expired', payload.reason ?? 'The site logged you out. Please sign in again.');
      }
      case 'page.navigated': {
        const payload = (event.payload ?? {}) as { url?: string };
        // A fresh navigation away from a login page clears a stale expiry.
        if (this.status.health === 'expired' && payload.url && !/\/(login|signin|sign-in)/i.test(payload.url)) {
          return this.transition('ok', 'Session restored.');
        }
        return null;
      }
      default:
        return null;
    }
  }

  /** Manually marks the session as healthy again. */
  reset(): SessionStatus {
    this.transition('ok', 'Session healthy.');
    return this.status;
  }

  private transition(health: SessionHealth, detail: string): SessionStatus | null {
    const next: SessionStatus = { health, detail, at: Date.now() };
    const changed = next.health !== this.status.health;
    this.status = next;
    this.history.push(next);
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    if (changed) this.emit('change', next);
    return changed ? next : null;
  }
}
