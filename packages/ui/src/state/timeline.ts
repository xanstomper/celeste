/**
 * Pure transforms between the raw `DaemonEvent` stream and the view models
 * the UI renders.
 *
 * Everything here is side-effect free so it can be unit tested and reused by
 * the reducer as well as by the mock daemon.
 */

import type {
  Artifact,
  ApprovalRequest,
  BrowserActionInfo,
  BrowserElementInfo,
  CanvasState,
  ChatMessage,
  ContentPart,
  DaemonEvent,
  ImagePart,
  PlanStep,
  Role,
  Source,
  TaskState,
  TaskStatus,
  ToolCall,
} from '@celeste/protocol';

/* -------------------------------------------------------------------------- */
/* Timeline view models                                                        */
/* -------------------------------------------------------------------------- */

export interface MessageTimelineItem {
  kind: 'message';
  id: string;
  at: number;
  role: Role;
  text: string;
  /** Provider bookkeeping (e.g. the model id) shown as a small badge. */
  name: string | undefined;
  toolCalls: ToolCall[] | undefined;
  /** Images the user attached to this message. */
  images?: ImagePart[];
}

/**
 * A workspace the agent built: report, visual page, image or project.
 */
export interface CanvasTimelineItem {
  kind: 'canvas';
  id: string;
  at: number;
  canvas: CanvasState;
}

/**
 * The answer as it is being written.
 *
 * A preview only: the complete assistant message arrives immediately after
 * and replaces this item, so the transcript always ends up holding exactly
 * what the daemon stored.
 */
export interface StreamingTimelineItem {
  kind: 'streaming';
  id: string;
  at: number;
  text: string;
}

export interface ToolTimelineItem {
  kind: 'tool';
  id: string;
  at: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: 'running' | 'ok' | 'error';
  summary: string;
  durationMs: number;
  data: unknown;
  error: { code: string; message: string } | undefined;
  /** Web sources this call contributed, numbered across the task. */
  sources: Source[] | undefined;
}

export interface SuggestionsTimelineItem {
  kind: 'suggestions';
  id: string;
  at: number;
  questions: string[];
}

export interface PlanTimelineItem {
  kind: 'plan';
  id: string;
  at: number;
  steps: PlanStep[];
}

export interface ApprovalTimelineItem {
  kind: 'approval';
  id: string;
  at: number;
  request: ApprovalRequest;
  decision: 'approve' | 'deny' | undefined;
}

export interface HumanTimelineItem {
  kind: 'human';
  id: string;
  at: number;
  reason: string;
}

export interface ArtifactTimelineItem {
  kind: 'artifact';
  id: string;
  at: number;
  artifact: Artifact;
}

export interface ErrorTimelineItem {
  kind: 'error';
  id: string;
  at: number;
  code: string;
  message: string;
}

export interface StatusTimelineItem {
  kind: 'status';
  id: string;
  at: number;
  status: TaskStatus;
  label: string;
}

export interface BrowserTimelineItem {
  kind: 'browser';
  id: string;
  at: number;
  action: BrowserActionInfo;
}

export type TimelineItem =
  | MessageTimelineItem
  | StreamingTimelineItem
  | CanvasTimelineItem
  | BrowserTimelineItem
  | ToolTimelineItem
  | PlanTimelineItem
  | SuggestionsTimelineItem
  | ApprovalTimelineItem
  | HumanTimelineItem
  | ArtifactTimelineItem
  | ErrorTimelineItem
  | StatusTimelineItem;

/* -------------------------------------------------------------------------- */
/* Message helpers                                                             */
/* -------------------------------------------------------------------------- */

function isContentPart(value: unknown): value is ContentPart {
  return typeof value === 'object' && value !== null && 'type' in value;
}

/** Flattens the `string | ContentPart[]` content union into plain text. */
function sameContent(a: ChatMessage['content'], b: ChatMessage['content']): boolean {
  if (a === b) return true;
  if (typeof a === 'string' || typeof b === 'string') return false;
  if (a.length !== b.length) return false;
  return a.every((part, index) => {
    const other = b[index];
    if (!other || part.type !== other.type) return false;
    if (part.type === 'text') return other.type === 'text' && part.text === other.text;
    return (
      other.type === 'image' && part.data === other.data && part.mimeType === other.mimeType
    );
  });
}

/** The image parts of a message, if it has any. */
export function imagesOf(message: ChatMessage): ImagePart[] {
  return Array.isArray(message.content)
    ? message.content.filter((part): part is ImagePart => part.type === 'image')
    : [];
}

export function extractMessageText(message: ChatMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isContentPart)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/** A short, single line preview used by the sidebar. */
export function previewText(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/* -------------------------------------------------------------------------- */
/* Task projection                                                             */
/* -------------------------------------------------------------------------- */

function deriveTitle(text: string, fallback: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return fallback;
  return flat.length > 72 ? `${flat.slice(0, 71)}…` : flat;
}

/** Titles the daemon may use before it knows what the task is about. */
const PLACEHOLDER_TITLES = new Set(['', 'Untitled', 'Untitled task', 'Untitled session', 'New task']);

/**
 * Folds a single daemon event into the canonical task snapshot.
 *
 * The daemon is the source of truth, but the UI also wants live updates while
 * a task runs, so the projection is applied locally as events arrive.
 */
export function applyEventToTask(task: TaskState, event: DaemonEvent): TaskState {
  const at = event.at;
  switch (event.type) {
    case 'task.created':
      return {
        ...task,
        id: event.taskId,
        title: event.title || task.title,
        status: 'queued',
        createdAt: at,
        updatedAt: at,
      };

    case 'task.status':
      return { ...task, status: event.status, updatedAt: at };

    case 'task.plan':
      return { ...task, plan: event.plan, updatedAt: at };

    case 'task.canvas':
      return { ...task, canvas: event.canvas, updatedAt: at };

    case 'task.browser.action': {
      const history = task.browserHistory ? [...task.browserHistory, event.action] : [event.action];
      if (history.length > 50) history.shift();
      return {
        ...task,
        activeBrowser: event.action,
        browserHistory: history,
        updatedAt: at,
      };
    }

    case 'task.message': {
      const incoming = event.message;
      const duplicate = task.messages.some(
        (message) =>
          message.role === incoming.role &&
          sameContent(message.content, incoming.content) &&
          message.toolCallId === incoming.toolCallId,
      );
      const messages = duplicate ? task.messages : [...task.messages, incoming];
      const firstUser = messages.find((m) => m.role === 'user');
      const title = PLACEHOLDER_TITLES.has(task.title)
        ? firstUser
          ? deriveTitle(extractMessageText(firstUser), task.title)
          : task.title
        : task.title;
      return { ...task, messages, title, updatedAt: at };
    }

    case 'task.tool.start':
      return {
        ...task,
        updatedAt: at,
        scratch: { ...task.scratch, [`tool:${event.callId}`]: { startedAt: at } },
      };

    case 'task.tool.end':
      return {
        ...task,
        updatedAt: at,
        scratch: {
          ...task.scratch,
          [`tool:${event.callId}`]: {
            startedAt: at,
            ok: event.ok,
            durationMs: event.durationMs,
          },
        },
      };

    case 'task.artifact': {
      const artifacts = task.artifacts.some((a) => a.path === event.artifact.path)
        ? task.artifacts
        : [...task.artifacts, event.artifact];
      return { ...task, artifacts, updatedAt: at };
    }

    case 'task.approval':
      return { ...task, status: 'awaiting_approval', updatedAt: at };

    case 'task.human':
      return { ...task, status: 'awaiting_human', updatedAt: at };

    case 'task.done': {
      const status: TaskStatus =
        event.status === 'completed' ? 'completed' : event.status === 'failed' ? 'failed' : 'cancelled';
      return { ...task, status, updatedAt: at };
    }

    default:
      return task;
  }
}

/* -------------------------------------------------------------------------- */
/* Timeline projection                                                         */
/* -------------------------------------------------------------------------- */

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Waiting for approval',
  awaiting_human: 'Waiting for you',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function statusLabel(status: TaskStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * Folds the raw event stream into the ordered list of cards the timeline
 * renders. Tool start/end pairs collapse into a single card, plan updates
 * replace the previous plan in place, and approvals stay addressable.
 */
export function buildTimeline(events: readonly DaemonEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolIndex = new Map<string, number>();
  const approvalIndex = new Map<string, number>();
  let planIndex = -1;
  let suggestionsIndex = -1;
  let streamIndex = -1;
  let canvasIndex = -1;

  events.forEach((event, index) => {
    const key = `e${index}`;

    // The finished message replaces the preview, so the reader never sees the
    // same answer twice.
    if (event.type === 'task.message' && event.message.role === 'assistant' && streamIndex >= 0) {
      items.splice(streamIndex, 1);
      if (planIndex > streamIndex) planIndex -= 1;
      if (suggestionsIndex > streamIndex) suggestionsIndex -= 1;
      streamIndex = -1;
    }

    switch (event.type) {
      case 'task.created':
        return;

      case 'task.status': {
        // Live progress only. A terminal status is rendered from `task.done`,
        // which is the single authoritative end-of-run marker — otherwise the
        // thread shows the same "completed" row twice.
        if (
          event.status === 'queued' ||
          event.status === 'running' ||
          event.status === 'completed' ||
          event.status === 'failed' ||
          event.status === 'cancelled'
        ) {
          return;
        }
        const previous = items[items.length - 1];
        if (previous?.kind === 'status' && previous.status === event.status) return;
        items.push({
          kind: 'status',
          id: key,
          at: event.at,
          status: event.status,
          label: STATUS_LABELS[event.status] ?? event.status,
        });
        return;
      }

      case 'task.plan': {
        if (planIndex >= 0) {
          const existing = items[planIndex];
          if (existing && existing.kind === 'plan') {
            items[planIndex] = { ...existing, steps: event.plan };
          }
          return;
        }
        planIndex = items.length;
        items.push({ kind: 'plan', id: key, at: event.at, steps: event.plan });
        return;
      }

      case 'task.canvas': {
        if (canvasIndex >= 0) {
          items[canvasIndex] = {
            kind: 'canvas',
            id: key,
            at: event.at,
            canvas: event.canvas,
          };
          return;
        }
        canvasIndex = items.length;
        items.push({ kind: 'canvas', id: key, at: event.at, canvas: event.canvas });
        return;
      }

      case 'task.delta': {
        if (streamIndex >= 0) {
          const existing = items[streamIndex];
          if (existing?.kind === 'streaming') {
            items[streamIndex] = { ...existing, text: existing.text + event.delta, at: event.at };
            return;
          }
        }
        streamIndex = items.length;
        items.push({ kind: 'streaming', id: key, at: event.at, text: event.delta });
        return;
      }

      case 'task.message': {
        // A new question ends the previous answer's life: its follow-ups no
        // longer belong anywhere.
        if (event.message.role === 'user' && suggestionsIndex >= 0) {
          items.splice(suggestionsIndex, 1);
          suggestionsIndex = -1;
        }
        items.push({
          kind: 'message',
          id: key,
          at: event.at,
          role: event.message.role,
          text: extractMessageText(event.message),
          name: event.message.name,
          toolCalls: event.message.toolCalls,
          images: imagesOf(event.message),
        });
        return;
      }

      case 'task.suggestions': {
        if (event.suggestions.length === 0) return;
        if (suggestionsIndex >= 0) {
          items[suggestionsIndex] = {
            kind: 'suggestions',
            id: key,
            at: event.at,
            questions: event.suggestions,
          };
          return;
        }
        suggestionsIndex = items.length;
        items.push({
          kind: 'suggestions',
          id: key,
          at: event.at,
          questions: event.suggestions,
        });
        return;
      }

      case 'task.tool.start': {
        const item: ToolTimelineItem = {
          kind: 'tool',
          id: `tool-${event.callId}`,
          at: event.at,
          callId: event.callId,
          toolName: event.toolName,
          arguments: event.arguments ?? {},
          status: 'running',
          summary: 'Running…',
          durationMs: 0,
          data: undefined,
          sources: undefined,
          error: undefined,
        };
        toolIndex.set(event.callId, items.length);
        items.push(item);
        return;
      }

      case 'task.tool.end': {
        const idx = toolIndex.get(event.callId);
        const item: ToolTimelineItem = {
          kind: 'tool',
          id: `tool-${event.callId}`,
          at: event.at,
          callId: event.callId,
          toolName: event.toolName,
          arguments: {},
          status: event.ok ? 'ok' : 'error',
          summary: event.summary,
          durationMs: event.durationMs,
          data: event.data,
          error: event.error,
          sources: event.sources,
        };
        if (idx === undefined) {
          toolIndex.set(event.callId, items.length);
          items.push(item);
          return;
        }
        const existing = items[idx];
        if (existing && existing.kind === 'tool') {
          items[idx] = { ...existing, ...item, at: existing.at, arguments: existing.arguments };
        }
        return;
      }

      case 'task.artifact': {
        items.push({
          kind: 'artifact',
          id: `artifact-${event.artifact.path}-${index}`,
          at: event.at,
          artifact: event.artifact,
        });
        return;
      }

      case 'task.approval': {
        const item: ApprovalTimelineItem = {
          kind: 'approval',
          id: `approval-${event.request.id}`,
          at: event.at,
          request: event.request,
          decision: undefined,
        };
        approvalIndex.set(event.request.id, items.length);
        items.push(item);
        return;
      }

      case 'task.human': {
        items.push({ kind: 'human', id: key, at: event.at, reason: event.reason });
        return;
      }

      case 'task.browser.action': {
        items.push({
          kind: 'browser',
          id: `browser-${event.action.id}`,
          at: event.at,
          action: event.action,
        });
        return;
      }

      case 'task.done': {
        const status: TaskStatus =
          event.status === 'completed'
            ? 'completed'
            : event.status === 'failed'
              ? 'failed'
              : 'cancelled';

        // A finished answer speaks for itself — the header already says
        // "completed". Only an abnormal ending is worth a divider.
        if (status === 'completed') return;

        // A retried run can end twice with the same status; one divider is
        // enough to mark the turn.
        const previous = items[items.length - 1];
        if (previous?.kind === 'status' && previous.status === status) {
          items[items.length - 1] = { ...previous, at: event.at };
          return;
        }

        items.push({
          kind: 'status',
          id: key,
          at: event.at,
          status,
          label: STATUS_LABELS[status],
        });
        return;
      }

      default:
        return;
    }
  });

  void approvalIndex;
  return items;
}

/** Merges an approval decision into the timeline without touching the raw events. */
export function withApprovalDecision(
  items: readonly TimelineItem[],
  requestId: string,
  decision: 'approve' | 'deny',
): TimelineItem[] {
  return items.map((item) => {
    if (item.kind === 'approval' && item.request.id === requestId) {
      return { ...item, decision };
    }
    return item;
  });
}

/* -------------------------------------------------------------------------- */
/* Snapshot projection                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Builds a timeline from the task snapshot returned by the daemon.
 *
 * The HTTP session endpoint only carries the persisted transcript, not the
 * tool-execution history, so this is what the UI shows before the event
 * stream catches up.
 */
export function buildTimelineFromTask(task: TaskState): TimelineItem[] {
  const items: TimelineItem[] = [];
  if (task.plan.length > 0) {
    items.push({ kind: 'plan', id: 'snapshot-plan', at: task.createdAt, steps: task.plan });
  }
  task.messages.forEach((message, index) => {
    items.push({
      kind: 'message',
      id: `snapshot-msg-${index}`,
      at: task.createdAt + index,
      role: message.role,
      text: extractMessageText(message),
      name: message.name,
      toolCalls: message.toolCalls,
      images: imagesOf(message),
    });
  });
  task.artifacts.forEach((artifact, index) => {
    items.push({
      kind: 'artifact',
      id: `snapshot-artifact-${index}`,
      at: artifact.createdAt,
      artifact,
    });
  });
  if (task.canvas) {
    items.push({
      kind: 'canvas',
      id: 'snapshot-canvas',
      at: task.canvas.updatedAt,
      canvas: task.canvas,
    });
  }
  if (task.suggestions && task.suggestions.length > 0) {
    items.push({
      kind: 'suggestions',
      id: 'snapshot-suggestions',
      at: task.updatedAt,
      questions: task.suggestions,
    });
  }
  if (task.error) {
    items.push({
      kind: 'error',
      id: 'snapshot-error',
      at: task.updatedAt,
      code: task.error.code,
      message: task.error.message,
    });
  }
  return items;
}

/**
 * Removes duplicate chat bubbles.
 *
 * The daemon may replay a message that the UI already echoed locally (for
 * example the prompt that created the task), so the timeline keeps only the
 * first occurrence of each role/text pair.
 */
export function dedupeMessages(items: readonly TimelineItem[]): TimelineItem[] {
  const seen = new Set<string>();
  const result: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind === 'message') {
      const key = `${item.role}:${item.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    result.push(item);
  }
  return result;
}

/**
 * Reconciles the snapshot timeline with the streamed one.
 *
 * Streamed events win; snapshot-only content (history the daemon did not
 * replay) is prepended so the ordering still reads chronologically.
 */
export function mergeTimeline(
  snapshot: readonly TimelineItem[],
  streamed: readonly TimelineItem[],
): TimelineItem[] {
  if (streamed.length === 0) return [...snapshot];
  if (snapshot.length === 0) return [...streamed];

  const hasPlan = streamed.some((item) => item.kind === 'plan');
  const artifactPaths = new Set(
    streamed.filter((item) => item.kind === 'artifact').map((item) => item.artifact.path),
  );
  const messageKeys = new Set(
    streamed.filter((item) => item.kind === 'message').map((item) => `${item.role}:${item.text}`),
  );
  const errorKeys = new Set(
    streamed.filter((item) => item.kind === 'error').map((item) => `${item.code}:${item.message}`),
  );

  const hasSuggestions = streamed.some((item) => item.kind === 'suggestions');
  // Follow-up questions are a footer, not history: they always come last.
  const snapshotSuggestions = snapshot.filter((item) => item.kind === 'suggestions');

  const extras = snapshot.filter((item) => {
    if (item.kind === 'plan') return !hasPlan;
    if (item.kind === 'artifact') return !artifactPaths.has(item.artifact.path);
    if (item.kind === 'message') return !messageKeys.has(`${item.role}:${item.text}`);
    if (item.kind === 'error') return !errorKeys.has(`${item.code}:${item.message}`);
    return false;
  });

  return [
    ...extras,
    ...streamed,
    ...(hasSuggestions ? [] : snapshotSuggestions),
  ];
}
