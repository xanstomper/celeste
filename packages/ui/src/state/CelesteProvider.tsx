/**
 * Wires the store to a daemon transport.
 *
 * The transport is either the real HTTP/SSE daemon or the in-browser mock.
 * Switching between them is transparent to every component.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { Attachment, DaemonEvent, ResearchDepth, SearchFocus } from '@celeste/protocol';

import { EventDeduper, useGlobalEvents, useSessionEvents } from '../api/events';
import { readEnvApiBase, toApiError } from '../api/client';
import type { DaemonTransport } from '../api/client';
import { connectDaemon } from '../api/connect';
import {
  applyEventToTask,
  buildTimeline,
  buildTimelineFromTask,
  dedupeMessages,
  mergeTimeline,
  withApprovalDecision,
} from './timeline';
import type { TimelineItem } from './timeline';
import {
  CelesteContext,
  celesteReducer,
  initialCelesteState,
} from './useCeleste';
import type {
  CelesteActions,
  CelesteContextValue,
  CelesteState,
  Settings,
  Theme,
  Toast,
} from './useCeleste';
import { persistSettings } from './useCeleste';

/** A unique id for one browser action, so the panel can key and dedupe them. */
let browserActionCounter = 0;
function nextBrowserActionId(): string {
  browserActionCounter += 1;
  return `browser_action_${Date.now().toString(36)}_${browserActionCounter.toString(36)}`;
}

export function CelesteProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(celesteReducer, undefined, initialCelesteState);
  const [, setTransportVersion] = useState(0);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const transportRef = useRef<DaemonTransport | null>(null);
  const deduperRef = useRef(new EventDeduper());
  const connectTokenRef = useRef(0);

  const notify = useCallback((kind: Toast['kind'], text: string) => {
    dispatch({
      type: 'toast',
      toast: { id: `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, kind, text },
    });
  }, []);

  const effectiveApiBase = useMemo(() => {
    const configured = state.settings.apiBase.trim();
    return configured || readEnvApiBase();
  }, [state.settings.apiBase]);

  const applyTransportEvent = useCallback((event: DaemonEvent) => {
    if (!deduperRef.current.accept(event)) return;
    const sessionId = 'taskId' in event ? event.taskId : '';
    dispatch({ type: 'event', sessionId, event });
  }, []);

  const hydrate = useCallback(
    async (transport: DaemonTransport) => {
      try {
        const [providers, sessions, artifacts, health] = await Promise.all([
          transport.listProviders(),
          transport.listSessions(),
          transport.listArtifacts(),
          transport.health(),
        ]);
        dispatch({ type: 'providers', providers });
        dispatch({ type: 'sessions', sessions });
        dispatch({ type: 'artifacts', artifacts });
        dispatch({ type: 'health', health });
      } catch (err) {
        notify('error', toApiError(err).message);
      }
    },
    [notify],
  );

  const connect = useCallback(
    async (mode: 'auto' | 'live' | 'demo') => {
      const token = connectTokenRef.current + 1;
      connectTokenRef.current = token;

      transportRef.current?.dispose();
      transportRef.current = null;
      deduperRef.current.clear();
      dispatch({ type: 'clearEvents' });
      if (mode !== 'demo') {
        dispatch({ type: 'connection', status: 'connecting' });
      }

      const result = await connectDaemon({
        mode,
        base: stateRef.current.settings.apiBase.trim() || readEnvApiBase(),
      });

      // A newer connection attempt won the race - drop this one.
      if (connectTokenRef.current !== token) {
        result.transport.dispose();
        return;
      }

      transportRef.current = result.transport;
      dispatch({
        type: 'connection',
        status: result.status,
        error: result.status === 'demo' ? result.error : undefined,
      });
      setTransportVersion((v) => v + 1);
      await hydrate(result.transport);

      if (mode === 'live' && result.status === 'demo') {
        notify('warn', `${result.error ?? 'The daemon is unreachable'} — running in demo mode.`);
      }
    },
    [hydrate, notify],
  );

  /* Boot once. */
  useEffect(() => {
    void connect('auto');
  }, [connect]);

  /* Stream events for the active session and for the whole daemon. */
  const transport = transportRef.current;
  useSessionEvents(transport, state.activeSessionId, applyTransportEvent);
  useGlobalEvents(transport, applyTransportEvent, () => {
    // The daemon restarted (or came back): refill the session list so the
    // panel is not left showing a snapshot from before the gap.
    const current = transportRef.current;
    if (current) void hydrate(current);
  });

  /* Persist + reflect theme changes. */
  useEffect(() => {
    persistSettings(state.settings);
    if (typeof document !== 'undefined') {
      document.documentElement.dataset['theme'] = state.settings.theme;
    }
  }, [state.settings]);

  const selectSession = useCallback((id: string) => {
    dispatch({ type: 'select', id });
  }, []);

  /** Opens a blank thread: no active session, no events on screen. */
  const newTask = useCallback(() => {
    dispatch({ type: 'select', id: null });
  }, []);

  const createSession = useCallback(
    async (
      prompt: string,
      focus?: SearchFocus,
      depth?: ResearchDepth,
      attachments?: Attachment[],
    ) => {
      const current = transportRef.current;
      if (!current) return;
      const trimmed = prompt.trim();
      if (!trimmed) return;
      dispatch({ type: 'busy', busy: true });
      try {
        const task = await current.createSession({
          prompt: trimmed,
          ...(focus && focus !== 'web' ? { focus } : {}),
          ...(depth ? { depth } : {}),
          ...(attachments?.length ? { attachments } : {}),
          autoApprove: stateRef.current.settings.autoApprove,
          outputDir: stateRef.current.settings.outputDir,
        });
        dispatch({ type: 'session', task });
        // Echo the prompt locally so the transcript always opens with the
        // user's own words, even before the daemon streams it back.
        dispatch({
          type: 'event',
          sessionId: task.id,
          event: {
            type: 'task.message',
            taskId: task.id,
            message: {
              role: 'user',
              content:
                attachments && attachments.length > 0
                  ? [
                      { type: 'text' as const, text: trimmed },
                      ...attachments.map((attachment) => ({
                        type: 'image' as const,
                        data: attachment.data,
                        mimeType: attachment.mimeType,
                      })),
                    ]
                  : trimmed,
            },
            at: Date.now(),
          },
        });
        dispatch({ type: 'select', id: task.id });
        notify('ok', 'Task created');
      } catch (err) {
        notify('error', toApiError(err).message);
      } finally {
        dispatch({ type: 'busy', busy: false });
      }
    },
    [notify],
  );

  const sendMessage = useCallback(
    async (content: string, attachments?: Attachment[]) => {
      const current = transportRef.current;
      const trimmed = content.trim();
      if (!current || (!trimmed && !attachments?.length)) return;
      const sessionId = stateRef.current.activeSessionId;
      if (!sessionId) {
        await createSession(trimmed, undefined, undefined, attachments);
        return;
      }
      dispatch({ type: 'busy', busy: true });
      try {
        await current.sendMessage(sessionId, trimmed, attachments);
      } catch (err) {
        notify('error', toApiError(err).message);
      } finally {
        dispatch({ type: 'busy', busy: false });
      }
    },
    [createSession, notify],
  );

  const respondApproval = useCallback(
    async (requestId: string, decision: 'approve' | 'deny') => {
      const current = transportRef.current;
      const sessionId = stateRef.current.activeSessionId;
      if (!current || !sessionId) return;
      dispatch({ type: 'approvalDecision', requestId, decision });
      try {
        await current.approve(sessionId, { requestId, decision });
      } catch (err) {
        notify('error', toApiError(err).message);
      }
    },
    [notify],
  );

  const cancelTask = useCallback(async () => {
    const current = transportRef.current;
    const sessionId = stateRef.current.activeSessionId;
    if (!current || !sessionId) return;
    dispatch({ type: 'busy', busy: true });
    try {
      await current.cancel(sessionId);
      notify('info', 'Task cancelled');
    } catch (err) {
      notify('error', toApiError(err).message);
    } finally {
      dispatch({ type: 'busy', busy: false });
    }
  }, [notify]);

  const switchProvider = useCallback(
    async (id: string) => {
      const current = transportRef.current;
      if (!current) return;
      const previous = stateRef.current.providers;
      dispatch({
        type: 'providers',
        providers: previous.map((provider) => ({ ...provider, active: provider.id === id })),
      });
      try {
        const provider = await current.switchProvider(id);
        dispatch({ type: 'provider', provider });
        notify('ok', `Switched to ${provider.label}`);
      } catch (err) {
        dispatch({ type: 'providers', providers: previous });
        notify('error', toApiError(err).message);
      }
    },
    [notify],
  );

  const navigateBrowser = useCallback(
    async (url: string) => {
      const current = transportRef.current;
      if (!current) return;
      try {
        const res = await current.navigateBrowser?.(url);
        const shot = await current.getBrowserScreenshot?.();
        if (shot?.data) {
          dispatch({
            type: 'browser',
            action: {
              id: nextBrowserActionId(),
              action: 'navigate',
              url,
              title: ((res?.result as Record<string, unknown>)?.title as string) || url,
              screenshot: shot.data,
              at: Date.now(),
            },
          });
        }
      } catch (err) {
        notify('error', `Navigation failed: ${toApiError(err).message}`);
      }
    },
    [notify],
  );

  const clickBrowser = useCallback(
    async (point: { x: number; y: number }, ref?: string) => {
      const current = transportRef.current;
      if (!current) return;
      try {
        await current.clickBrowser?.(point, ref);
        setTimeout(async () => {
          try {
            const shot = await current.getBrowserScreenshot?.();
            if (shot?.data) {
              dispatch({
                type: 'browser',
                action: {
                  id: nextBrowserActionId(),
                  action: 'click',
                  point,
                  ref,
                  screenshot: shot.data,
                  at: Date.now(),
                },
              });
            }
          } catch {
            /* ignore */
          }
        }, 350);
      } catch (err) {
        notify('error', `Click failed: ${toApiError(err).message}`);
      }
    },
    [notify],
  );

  const typeBrowser = useCallback(
    async (text: string, ref?: string) => {
      const current = transportRef.current;
      if (!current) return;
      try {
        await current.typeBrowser?.(text, ref);
        setTimeout(async () => {
          try {
            const shot = await current.getBrowserScreenshot?.();
            if (shot?.data) {
              dispatch({
                type: 'browser',
                action: {
                  id: nextBrowserActionId(),
                  action: 'type',
                  text,
                  ref,
                  screenshot: shot.data,
                  at: Date.now(),
                },
              });
            }
          } catch {
            /* ignore */
          }
        }, 300);
      } catch (err) {
        notify('error', `Typing failed: ${toApiError(err).message}`);
      }
    },
    [notify],
  );

  const scrollBrowser = useCallback(
    async (deltaY = 400) => {
      const current = transportRef.current;
      if (!current) return;
      try {
        await current.scrollBrowser?.(deltaY);
        setTimeout(async () => {
          try {
            const shot = await current.getBrowserScreenshot?.();
            if (shot?.data) {
              dispatch({
                type: 'browser',
                action: {
                  id: nextBrowserActionId(),
                  action: 'scroll',
                  title: `Scrolled ${deltaY > 0 ? 'down' : 'up'}`,
                  screenshot: shot.data,
                  at: Date.now(),
                },
              });
            }
          } catch {
            /* ignore */
          }
        }, 250);
      } catch (err) {
        notify('error', `Scroll failed: ${toApiError(err).message}`);
      }
    },
    [notify],
  );

  const captureScreenshot = useCallback(async () => {
    const current = transportRef.current;
    if (!current) return;
    try {
      const res = await current.getBrowserScreenshot?.();
      if (res?.data) {
        dispatch({
          type: 'browser',
          action: {
            id: nextBrowserActionId(),
            action: 'snapshot',
            title: 'Manual screenshot capture',
            screenshot: res.data,
            at: Date.now(),
          },
        });
        return res.data;
      }
      return undefined;
    } catch (err) {
      notify('error', `Screenshot failed: ${toApiError(err).message}`);
    }
  }, [notify]);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    dispatch({ type: 'settings', patch });
  }, []);

  const setTheme = useCallback((theme: Theme) => {
    dispatch({ type: 'settings', patch: { theme } });
  }, []);

  const toggleDemoMode = useCallback(async () => {
    const isDemo = stateRef.current.connection === 'demo';
    await connect(isDemo ? 'live' : 'demo');
  }, [connect]);

  const reconnect = useCallback(async () => {
    await connect('live');
  }, [connect]);

  const dismissHuman = useCallback((key: string) => {
    dispatch({ type: 'dismissHuman', key });
  }, []);

  const dismissToast = useCallback((id: string) => {
    dispatch({ type: 'dismissToast', id });
  }, []);

  const activeTask = useMemo(
    () => state.sessions.find((task) => task.id === state.activeSessionId) ?? null,
    [state.sessions, state.activeSessionId],
  );

  const timeline = useMemo(() => {
    const sessionId = state.activeSessionId;
    if (!sessionId) return [] as TimelineItem[];
    const streamed = buildTimeline(state.eventsBySession[sessionId] ?? []);
    const snapshot = activeTask ? buildTimelineFromTask(activeTask) : [];
    let items = dedupeMessages(mergeTimeline(snapshot, streamed));
    for (const [requestId, decision] of Object.entries(state.approvalDecisions)) {
      items = withApprovalDecision(items, requestId, decision);
    }
    return items;
  }, [state.activeSessionId, state.eventsBySession, state.approvalDecisions, activeTask]);

  const actions = useMemo<CelesteActions>(
    () => ({
      selectSession,
      newTask,
      createSession,
      sendMessage,
      respondApproval,
      cancelTask,
      switchProvider,
      navigateBrowser,
      clickBrowser,
      typeBrowser,
      scrollBrowser,
      captureScreenshot,
      setSettings,
      setTheme,
      toggleDemoMode,
      reconnect,
      dismissHuman,
      dismissToast,
      notify,
    }),
    [
      selectSession,
      createSession,
      sendMessage,
      respondApproval,
      cancelTask,
      switchProvider,
      navigateBrowser,
      clickBrowser,
      typeBrowser,
      scrollBrowser,
      captureScreenshot,
      setSettings,
      setTheme,
      toggleDemoMode,
      reconnect,
      dismissHuman,
      dismissToast,
      notify,
    ],
  );

  const value = useMemo<CelesteContextValue>(
    () => ({ state, actions, timeline, activeTask, effectiveApiBase }),
    [state, actions, timeline, activeTask, effectiveApiBase],
  );

  return <CelesteContext.Provider value={value}>{children}</CelesteContext.Provider>;
}
