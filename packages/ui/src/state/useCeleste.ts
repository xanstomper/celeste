/**
 * The store of the Celeste desktop client.
 *
 * A hand rolled `useReducer` + context keeps the dependency surface at
 * exactly React + ReactDOM, and gives us a single place to fold the daemon
 * event stream into the view model.
 *
 * The reducer and the context live here; the provider component that wires
 * them to the transports lives in `CelesteProvider.tsx`.
 */

import { createContext, useContext } from 'react';
import type {
  Artifact,
  DaemonEvent,
  HealthResponse,
  ProviderSummary,
  SearchFocus,
  TaskState,
} from '@celeste/protocol';

import {
  applyEventToTask,
  buildTimeline,
  buildTimelineFromTask,
  dedupeMessages,
  mergeTimeline,
  withApprovalDecision,
} from './timeline';
import type { TimelineItem } from './timeline';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type ConnectionStatus = 'connecting' | 'connected' | 'demo' | 'offline';
export type Theme = 'dark' | 'light';

export interface Settings {
  /** Where generated artifacts are written. */
  outputDir: string;
  /** Automatically approve risky tools. */
  autoApprove: boolean;
  /** Port the browser extension bridge listens on. */
  extensionPort: number;
  /** Overrides `VITE_CELESTE_API` when non-empty. */
  apiBase: string;
  theme: Theme;
}

export interface Toast {
  id: string;
  kind: 'info' | 'ok' | 'warn' | 'error';
  text: string;
}

export interface CelesteState {
  connection: ConnectionStatus;
  connectionError: string | null;
  health: HealthResponse | null;
  providers: ProviderSummary[];
  sessions: TaskState[];
  activeSessionId: string | null;
  eventsBySession: Record<string, DaemonEvent[]>;
  artifacts: Artifact[];
  extensionConnected: boolean;
  extensionDetail: string | undefined;
  settings: Settings;
  approvalDecisions: Record<string, 'approve' | 'deny'>;
  dismissedHumans: Record<string, true>;
  toasts: Toast[];
  busy: boolean;
}

export interface CelesteActions {
  selectSession: (id: string) => void;
  createSession: (prompt: string, focus?: SearchFocus) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  respondApproval: (requestId: string, decision: 'approve' | 'deny') => Promise<void>;
  cancelTask: () => Promise<void>;
  switchProvider: (id: string) => Promise<void>;
  setSettings: (patch: Partial<Settings>) => void;
  setTheme: (theme: Theme) => void;
  toggleDemoMode: () => Promise<void>;
  reconnect: () => Promise<void>;
  dismissHuman: (key: string) => void;
  dismissToast: (id: string) => void;
  notify: (kind: Toast['kind'], text: string) => void;
}

export interface CelesteContextValue {
  state: CelesteState;
  actions: CelesteActions;
  timeline: TimelineItem[];
  activeTask: TaskState | null;
  effectiveApiBase: string;
}

const SETTINGS_STORAGE_KEY = 'celeste.settings.v1';

const DEFAULT_SETTINGS: Settings = {
  outputDir: '~/celeste-output',
  autoApprove: false,
  extensionPort: 9126,
  apiBase: '',
  // Light first, like Perplexity's assistant panel.
  theme: 'light',
};

function loadSettings(): Settings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      outputDir:
        typeof parsed.outputDir === 'string' && parsed.outputDir
          ? parsed.outputDir
          : DEFAULT_SETTINGS.outputDir,
      autoApprove:
        typeof parsed.autoApprove === 'boolean' ? parsed.autoApprove : DEFAULT_SETTINGS.autoApprove,
      extensionPort:
        typeof parsed.extensionPort === 'number' && Number.isFinite(parsed.extensionPort)
          ? parsed.extensionPort
          : DEFAULT_SETTINGS.extensionPort,
      apiBase: typeof parsed.apiBase === 'string' ? parsed.apiBase : DEFAULT_SETTINGS.apiBase,
      theme: parsed.theme === 'light' ? 'light' : 'dark',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function persistSettings(settings: Settings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage disabled - settings stay in memory */
  }
}

/* -------------------------------------------------------------------------- */
/* Reducer                                                                     */
/* -------------------------------------------------------------------------- */

export type CelesteAction =
  | { type: 'connection'; status: ConnectionStatus; error?: string }
  | { type: 'health'; health: HealthResponse }
  | { type: 'providers'; providers: ProviderSummary[] }
  | { type: 'provider'; provider: ProviderSummary }
  | { type: 'sessions'; sessions: TaskState[] }
  | { type: 'session'; task: TaskState }
  | { type: 'select'; id: string | null }
  | { type: 'event'; sessionId: string; event: DaemonEvent }
  | { type: 'clearEvents' }
  | { type: 'artifacts'; artifacts: Artifact[] }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'approvalDecision'; requestId: string; decision: 'approve' | 'deny' }
  | { type: 'dismissHuman'; key: string }
  | { type: 'toast'; toast: Toast }
  | { type: 'dismissToast'; id: string }
  | { type: 'busy'; busy: boolean };

function blankTask(id: string, title: string, at: number): TaskState {
  return {
    id,
    title,
    status: 'queued',
    plan: [],
    messages: [],
    scratch: {},
    artifacts: [],
    createdAt: at,
    updatedAt: at,
  };
}

export function celesteReducer(
  state: CelesteState,
  action: CelesteAction,
): CelesteState {
  switch (action.type) {
    case 'connection':
      return {
        ...state,
        connection: action.status,
        connectionError: action.error ?? null,
      };

    case 'health':
      return {
        ...state,
        health: action.health,
        extensionConnected: action.health.extensionConnected,
      };

    case 'providers':
      return { ...state, providers: action.providers };

    case 'provider':
      return {
        ...state,
        providers: state.providers.map((provider) =>
          provider.id === action.provider.id
            ? { ...provider, active: true }
            : { ...provider, active: false },
        ),
        health: state.health
          ? {
              ...state.health,
              activeProvider: action.provider.id,
              activeModel: action.provider.model,
            }
          : state.health,
      };

    case 'sessions': {
      const sessions = [...action.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
      const activeStillExists = sessions.some((task) => task.id === state.activeSessionId);
      return {
        ...state,
        sessions,
        activeSessionId: activeStillExists ? state.activeSessionId : (sessions[0]?.id ?? null),
      };
    }

    case 'session': {
      const index = state.sessions.findIndex((task) => task.id === action.task.id);
      const sessions =
        index >= 0
          ? state.sessions.map((task) => (task.id === action.task.id ? action.task : task))
          : [action.task, ...state.sessions];
      return { ...state, sessions };
    }

    case 'select':
      return { ...state, activeSessionId: action.id };
    case 'clearEvents':
      return { ...state, eventsBySession: {} };

    case 'event': {
      const { event, sessionId } = action;

      if (event.type === 'extension.status') {
        return {
          ...state,
          extensionConnected: event.connected,
          extensionDetail: event.detail,
        };
      }

      if (event.type === 'provider.changed') {
        const providers = state.providers.map((provider) => ({
          ...provider,
          active: provider.id === event.providerId,
        }));
        return {
          ...state,
          providers,
          health: state.health
            ? { ...state.health, activeProvider: event.providerId, activeModel: event.model }
            : state.health,
        };
      }

      const list = state.eventsBySession[sessionId] ?? [];
      // Keep the stream chronological: events can arrive out of order when a
      // session is selected and its recorded history is replayed.
      const events = [...list, event].sort((a, b) => a.at - b.at);
      const eventsBySession = { ...state.eventsBySession, [sessionId]: events };

      const index = state.sessions.findIndex((task) => task.id === sessionId);
      let sessions = state.sessions;
      if (index >= 0) {
        const existing = state.sessions[index];
        if (existing) {
          const updated = applyEventToTask(existing, event);
          sessions = state.sessions.map((task, i) => (i === index ? updated : task));
        }
      } else if (event.type === 'task.created') {
        sessions = [applyEventToTask(blankTask(sessionId, event.title, event.at), event), ...sessions];
      }

      // Follow new work: when a task starts, show it — unless the user is
      // already looking at something that is still running.
      let activeSessionId = state.activeSessionId;
      if (event.type === 'task.created') {
        const current = sessions.find((task) => task.id === activeSessionId);
        const currentFinished =
          !current ||
          current.status === 'completed' ||
          current.status === 'failed' ||
          current.status === 'cancelled';
        if (currentFinished) activeSessionId = sessionId;
      }

      return { ...state, eventsBySession, sessions, activeSessionId };
    }

    case 'artifacts':
      return { ...state, artifacts: action.artifacts };

    case 'settings': {
      const settings = { ...state.settings, ...action.patch };
      persistSettings(settings);
      return { ...state, settings };
    }

    case 'approvalDecision':
      return {
        ...state,
        approvalDecisions: { ...state.approvalDecisions, [action.requestId]: action.decision },
      };

    case 'dismissHuman':
      return { ...state, dismissedHumans: { ...state.dismissedHumans, [action.key]: true } };

    case 'toast':
      return { ...state, toasts: [...state.toasts.slice(-3), action.toast] };

    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };

    case 'busy':
      return { ...state, busy: action.busy };

    default:
      return state;
  }
}

export function initialCelesteState(): CelesteState {
  const settings = loadSettings();
  return {
    connection: 'connecting',
    connectionError: null,
    health: null,
    providers: [],
    sessions: [],
    activeSessionId: null,
    eventsBySession: {},
    artifacts: [],
    extensionConnected: false,
    extensionDetail: undefined,
    settings,
    approvalDecisions: {},
    dismissedHumans: {},
    toasts: [],
    busy: false,
  };
}


/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

export const CelesteContext = createContext<CelesteContextValue | null>(null);

/**
 * Access the Celeste store. Must be used inside `<CelesteProvider>`.
 */
export function useCeleste(): CelesteContextValue {
  const context = useContext(CelesteContext);
  if (!context) {
    throw new Error('useCeleste must be used inside <CelesteProvider>');
  }
  return context;
}
