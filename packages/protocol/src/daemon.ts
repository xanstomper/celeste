/**
 * Daemon-side API contract: the HTTP surface exposed by the Celeste daemon
 * and the event stream consumed by the desktop client.
 *
 * The client (React UI) and the daemon (Node core) are versioned together via
 * {@link DAEMON_API_VERSION}.
 */

import type {
  Artifact,
  ApprovalRequest,
  ChatMessage,
  PlanStep,
  SearchFocus,
  Source,
  TaskState,
  TaskStatus,
} from './types.js';

export const DAEMON_API_VERSION = '1.0.0';

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every event the daemon streams to the UI. The UI renders these as
 * collapsible tool-execution cards, per the product brief.
 */
export type DaemonEvent =
  | { type: 'task.created'; taskId: string; title: string; at: number }
  | { type: 'task.status'; taskId: string; status: TaskStatus; at: number }
  | { type: 'task.plan'; taskId: string; plan: PlanStep[]; at: number }
  | { type: 'task.message'; taskId: string; message: ChatMessage; at: number }
  | {
      type: 'task.tool.start';
      taskId: string;
      callId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      at: number;
    }
  | {
      type: 'task.tool.end';
      taskId: string;
      callId: string;
      toolName: string;
      ok: boolean;
      summary: string;
      durationMs: number;
      data?: unknown;
      error?: { code: string; message: string };
      /** Web sources this call contributed, numbered across the task. */
      sources?: Source[];
      at: number;
    }
  | { type: 'task.artifact'; taskId: string; artifact: Artifact; at: number }
  | { type: 'task.approval'; taskId: string; request: ApprovalRequest; at: number }
  | { type: 'task.human'; taskId: string; reason: string; at: number }
  | { type: 'task.done'; taskId: string; status: 'completed' | 'failed' | 'cancelled'; at: number }
  | {
      type: 'task.suggestions';
      taskId: string;
      /** Follow-up questions the reader is likely to ask next. */
      suggestions: string[];
      at: number;
    }
  | { type: 'extension.status'; connected: boolean; detail?: string; at: number }
  | { type: 'provider.changed'; providerId: string; model: string; at: number }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; at: number };

export type DaemonEventType = DaemonEvent['type'];

/* -------------------------------------------------------------------------- */
/* HTTP payloads                                                              */
/* -------------------------------------------------------------------------- */

export interface HealthResponse {
  ok: boolean;
  version: string;
  apiVersion: string;
  activeProvider?: string;
  activeModel?: string;
  extensionConnected: boolean;
  providerCount: number;
  uptimeSeconds: number;
}

export interface ProviderSummary {
  id: string;
  label: string;
  kind: string;
  model: string;
  baseUrl?: string | null;
  active: boolean;
  /** True when an API key could be resolved. */
  hasKey: boolean;
  source?: string;
}

export interface CreateSessionRequest {
  prompt: string;
  /** Where to research: the open web, papers, or the news. */
  focus?: SearchFocus;
  /** Optional override of the active provider for this session only. */
  providerId?: string;
  /** Approval policy for risky tools. */
  autoApprove?: boolean;
  /** Where generated files should be written. */
  outputDir?: string;
}

export interface CreateSessionResponse {
  task: TaskState;
}

export interface SessionListResponse {
  tasks: TaskState[];
}

export interface SessionDetailResponse {
  task: TaskState;
}

export interface ApprovalResponseRequest {
  requestId: string;
  decision: 'approve' | 'deny';
  /** Optional replacement arguments when the user edits the call. */
  arguments?: Record<string, unknown>;
}

export interface ArtifactListResponse {
  artifacts: Artifact[];
}

export interface ProviderSwitchRequest {
  id: string;
}

export interface ProviderSwitchResponse {
  active: ProviderSummary;
}

export interface ErrorResponse {
  error: string;
  code?: string;
}

/* -------------------------------------------------------------------------- */
/* Route table (documentation for both sides)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The canonical route table. Both the daemon router and the UI client derive
 * from this list so they can never drift.
 */
export const API_ROUTES = {
  health: '/api/health',
  providers: '/api/providers',
  providerActive: '/api/providers/active',
  sessions: '/api/sessions',
  session: (id: string) => `/api/sessions/${id}`,
  sessionEvents: (id: string) => `/api/sessions/${id}/events`,
  sessionApprove: (id: string) => `/api/sessions/${id}/approve`,
  sessionCancel: (id: string) => `/api/sessions/${id}/cancel`,
  sessionSend: (id: string) => `/api/sessions/${id}/message`,
  artifacts: '/api/artifacts',
  websocket: '/ws',
} as const;
