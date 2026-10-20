import type {
  Artifact,
  DaemonEvent,
  TaskState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@celeste/protocol';

/**
 * Scratchpad — a per-task key/value store that survives across steps and is
 * checkpointed with the task.
 */
export interface ScratchStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** Every key currently stored. */
  keys(): string[];
}

/** Gate used by tools that need a human decision mid-execution. */
export interface ApprovalGate {
  request(input: {
    toolName: string;
    arguments: Record<string, unknown>;
    reason: string;
    risk: 'low' | 'medium' | 'high';
  }): Promise<boolean>;
}

/**
 * The abstraction the browser tools use to talk to a real browser.
 * Implemented in `@celeste/core` by `BrowserBridge`; kept as an interface here
 * so the tools package has no dependency on the agent runtime.
 */
export interface BrowserClient {
  isConnected(): boolean;
  send<T = unknown>(
    action: string,
    params?: Record<string, unknown>,
    opts?: { tabId?: number; timeoutMs?: number },
  ): Promise<T>;
}

/** Everything a tool handler is given when it runs. */
export interface ToolContext {
  /** The task this call belongs to. */
  taskId: string;
  /** Aborts when the task is cancelled. */
  signal: AbortSignal;
  /** Event bus for streaming progress to the UI. */
  bus: { publish(event: DaemonEvent): void };
  /** Access to the task store (read task state, artifacts). */
  store: { get(id: string): TaskState | undefined };
  /** Per-task scratchpad. */
  scratch: ScratchStore;
  /** Where generated files should be written. */
  outputDir: string;
  /** Request human approval. */
  approval: ApprovalGate;
  /** Register a produced file with the task. */
  emitArtifact(artifact: Artifact): void;
}

/** A tool implementation. */
export interface ToolHandler {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Convenience helper for building a successful tool result. */
export function ok(
  call: ToolCall,
  summary: string,
  data?: unknown,
  text?: string,
): ToolResult {
  return {
    id: call.id,
    name: call.name,
    ok: true,
    summary,
    ...(data !== undefined ? { data } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

/** Convenience helper for building a failed tool result. */
export function fail(
  call: ToolCall,
  code: ToolResult['error'] extends undefined ? never : NonNullable<ToolResult['error']>['code'],
  message: string,
  retryable = false,
  details?: unknown,
): ToolResult {
  return {
    id: call.id,
    name: call.name,
    ok: false,
    summary: message,
    error: { code, message, retryable, ...(details !== undefined ? { details } : {}) },
  };
}
