/**
 * Core protocol types shared between the Celeste agent runtime, the browser
 * extension and any external MCP client.
 *
 * The wire format is deliberately JSON-only and versioned so that the
 * extension can be updated independently of the local daemon.
 */

export const PROTOCOL_VERSION = '1.0.0';

/* -------------------------------------------------------------------------- */
/* JSON Schema subset                                                         */
/* -------------------------------------------------------------------------- */

/** A minimal, JSON-Schema-ish description of a tool's arguments. */
export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: (string | number | boolean)[];
  default?: unknown;
  additionalProperties?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Tool contracts                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Where a tool physically runs.
 * - `local`  : executes inside the Celeste daemon (files, documents, memory).
 * - `browser`: executes inside the browser extension (page automation).
 */
export type ToolRuntime = 'local' | 'browser';

export interface ToolDefinition {
  /** Unique, stable identifier, e.g. `browser_navigate`. */
  name: string;
  /** Human/model readable purpose. Used directly in model tool prompts. */
  description: string;
  /** JSON schema of the argument object. */
  parameters: JsonSchema;
  /** Execution locality. */
  runtime: ToolRuntime;
  /** When true the agent must obtain explicit user approval before running it. */
  requiresApproval: boolean;
  /** Optional grouping used by the UI to organise tool cards. */
  category?: string;
}

/** A model-issued request to invoke a tool. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as produced by the model (may be a JSON string). */
  arguments: Record<string, unknown>;
}

/** The outcome of executing a ToolCall. */
export interface ToolResult {
  /** Mirrors ToolCall.id. */
  id: string;
  name: string;
  ok: boolean;
  /** Human readable summary shown in the UI. */
  summary: string;
  /** Structured payload returned to the model. */
  data?: unknown;
  /** Raw text output, when the model should read it verbatim. */
  text?: string;
  /** Set when `ok` is false. */
  error?: ToolError;
  /** Wall-clock duration of the call in milliseconds. */
  durationMs?: number;
  /**
   * Web sources this call contributed, numbered across the whole task.
   *
   * The agent cites them inline as `[n]`; the UI turns those markers into
   * links and renders a Perplexity-style source row underneath the answer.
   */
  sources?: Source[];
}

/** A web source the agent read or found while researching. */
export interface Source {
  /** Stable 1-based number used in inline citations, e.g. `[2]`. */
  n: number;
  title: string;
  url: string;
  /** Hostname without `www.`, used for the source badge. */
  domain: string;
  snippet?: string;
}

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  /** Whether retrying the exact same call could plausibly succeed. */
  retryable: boolean;
  details?: unknown;
}

export type ToolErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'NAVIGATION_FAILED'
  | 'ELEMENT_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'NEEDS_APPROVAL'
  | 'SESSION_EXPIRED'
  | 'CAPTCHA_DETECTED'
  | 'NETWORK_ERROR'
  | 'INTERNAL'
  | 'CANCELLED';

/* -------------------------------------------------------------------------- */
/* Chat / model messages                                                      */
/* -------------------------------------------------------------------------- */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** base64 encoded image bytes */
  data: string;
  mimeType: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  /** Set on assistant messages that request tool calls. */
  toolCalls?: ToolCall[];
  /** For `role: 'tool'` messages, references the originating tool call. */
  toolCallId?: string;
  /** Provider bookkeeping (openai id, anthropic block index, ...). */
  name?: string;
}

/* -------------------------------------------------------------------------- */
/* Task / session envelope                                                    */
/* -------------------------------------------------------------------------- */

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_human'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * What kind of sources the user is after.
 *
 * Perplexity calls these "focus modes": the answer is written the same way,
 * but the research looks in different places. `academic` adds papers,
 * `news` adds dated headlines, `web` is the open web only.
 */
export type SearchFocus = 'web' | 'academic' | 'news';

/**
 * A long-running unit of work. Checkpoints allow a task to resume after a
 * crash, a model switch, or a browser session reload.
 */
export interface TaskState {
  id: string;
  title: string;
  status: TaskStatus;
  /** Where this task researches. Absent means `web`. */
  focus?: SearchFocus;
  /** Ordered list of planned steps produced by the planner. */
  plan: PlanStep[];
  /** Transcript of the conversation so far. */
  messages: ChatMessage[];
  /** Arbitrary state blobs keyed by name, persisted between steps. */
  scratch: Record<string, unknown>;
  /** Files created by the task so far. */
  artifacts: Artifact[];
  /** Web sources this task has collected, numbered for citation. */
  sources?: Source[];
  /** Follow-up questions offered under the latest answer. */
  suggestions?: string[];
  createdAt: number;
  updatedAt: number;
  error?: ToolError;
}

export interface PlanStep {
  id: string;
  /** Imperative description of the step. */
  description: string;
  status: 'pending' | 'active' | 'done' | 'skipped' | 'failed';
  notes?: string;
}

export interface Artifact {
  path: string;
  kind: 'docx' | 'pdf' | 'xlsx' | 'pptx' | 'md' | 'txt' | 'json' | 'csv' | 'other';
  bytes: number;
  createdAt: number;
  description?: string;
}

/* -------------------------------------------------------------------------- */
/* Approval / human-in-the-loop                                               */
/* -------------------------------------------------------------------------- */

export interface ApprovalRequest {
  id: string;
  taskId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  /** Why the agent believes this needs approval. */
  reason: string;
  /** Risk label rendered in the UI. */
  risk: 'low' | 'medium' | 'high';
  createdAt: number;
}

export type ApprovalDecision = 'approve' | 'deny' | 'modify';

/* -------------------------------------------------------------------------- */
/* Browser primitives                                                         */
/* -------------------------------------------------------------------------- */

/** A stable identifier for an element on a page. */
export type ElementRef = string;

/** A compact, model friendly description of the interactive page. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Cleaned accessibility-ish tree. */
  elements: SnapshotElement[];
  /** Text content of the main body, truncated. */
  text?: string;
  /** True when the page looks like a CAPTCHA / bot challenge. */
  challenge?: boolean;
  /** Timestamp of capture. */
  capturedAt: number;
}

export interface SnapshotElement {
  ref: ElementRef;
  role: string;
  name: string;
  /** Tag name, lowercased. */
  tag?: string;
  /** Whether the element is currently visible in the viewport. */
  visible?: boolean;
  /** Bounding box in CSS pixels relative to the viewport. */
  box?: { x: number; y: number; width: number; height: number };
  /** Standard HTML attributes that matter for interaction. */
  attrs?: Record<string, string>;
  /** Child element refs, for tree structure. */
  children?: ElementRef[];
}

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  favIconUrl?: string;
}

/** A captured background network request. */
export interface NetworkEntry {
  id: string;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  /** Parsed JSON body when available, else raw text (truncated). */
  body?: string;
  headers?: Record<string, string>;
  /** True when the body was valid JSON. */
  isJson: boolean;
  timestamp: number;
}

/* -------------------------------------------------------------------------- */
/* Transport envelopes                                                        */
/* -------------------------------------------------------------------------- */

/** Envelope sent from the extension (or any client) to the daemon. */
export interface ClientMessage {
  v: string;
  type: string;
  id?: string;
  payload?: unknown;
}

/** Envelope sent from the daemon to the extension. */
export interface ServerMessage {
  v: string;
  type: string;
  id?: string;
  payload?: unknown;
}

/** Discriminator for the client -> server message union. */
export type ClientMessageType =
  | 'hello'
  | 'browser.command'
  | 'browser.result'
  | 'event'
  | 'task.request'
  | 'ping';

export type ServerMessageType =
  | 'welcome'
  | 'browser.command'
  | 'browser.result'
  | 'event'
  | 'approval.request'
  | 'approval.response'
  | 'pong'
  | 'error';

/** Events pushed from the extension without an explicit request. */
export interface ExtensionEvent {
  type:
    | 'tab.created'
    | 'tab.removed'
    | 'tab.activated'
    | 'page.navigated'
    | 'page.loaded'
    | 'page.title'
    | 'dom.mutated'
    | 'network.captured'
    | 'challenge.detected'
    | 'session.expired'
    | 'session.restored'
    | 'console.message'
    | 'human.required'
    | 'celeste:diagnostic';
  payload?: unknown;
  timestamp: number;
}

/* -------------------------------------------------------------------------- */
/* Tool result payload shapes (browser runtime)                                */
/* -------------------------------------------------------------------------- */

export interface NavigateResult {
  url: string;
  title: string;
  status?: number;
  snapshot?: PageSnapshot;
}

export interface ClickResult {
  ok: true;
  ref?: ElementRef;
  /** Where the click landed, in CSS pixels. */
  point?: { x: number; y: number };
  navigated?: boolean;
  url?: string;
}

export interface TypeResult {
  ok: true;
  typed: string;
  ref?: ElementRef;
}

export interface ExtractResult {
  url: string;
  title: string;
  markdown: string;
  links: { text: string; href: string }[];
  metadata: Record<string, string>;
}

export interface ScreenshotResult {
  mimeType: string;
  /** base64 encoded PNG. */
  data: string;
  width: number;
  height: number;
}

export interface EvaluateResult {
  value: unknown;
  /** When the expression threw. */
  error?: string;
}
