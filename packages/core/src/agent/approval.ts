import { createId } from '@celeste/protocol';
import type { ApprovalRequest } from '@celeste/protocol';
import type { EventBus } from '../events.js';

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: 'approve' | 'deny') => void;
  timer: NodeJS.Timeout;
}

/**
 * Human-in-the-loop approval.
 *
 * When the agent wants to take a consequential action, the run pauses, the UI
 * shows the request, and the agent waits. Nothing irreversible happens
 * without a human saying so.
 */
export class ApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly bus: EventBus) {}

  /**
   * Requests approval and blocks until a decision arrives.
   * Resolves `true` when approved, `false` when denied or timed out.
   */
  async request(
    taskId: string,
    input: {
      toolName: string;
      arguments: Record<string, unknown>;
      reason: string;
      risk: 'low' | 'medium' | 'high';
    },
    timeoutMs = 10 * 60_000,
  ): Promise<boolean> {
    const request: ApprovalRequest = {
      id: createId('apr'),
      taskId,
      toolName: input.toolName,
      arguments: input.arguments,
      reason: input.reason,
      risk: input.risk,
      createdAt: Date.now(),
    };

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        resolve(false);
      }, timeoutMs);

      this.pending.set(request.id, {
        request,
        resolve: (decision) => {
          clearTimeout(timer);
          this.pending.delete(request.id);
          resolve(decision === 'approve');
        },
        timer,
      });

      this.bus.publish({ type: 'task.approval', taskId, request, at: Date.now() });
    });
  }

  /** Resolves a pending approval from the UI. */
  resolve(requestId: string, decision: 'approve' | 'deny'): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.resolve(decision);
    return true;
  }

  /** Number of approvals currently waiting. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Cancels every pending approval (used when a task is cancelled). */
  cancelAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve('deny');
    }
    this.pending.clear();
  }
}
