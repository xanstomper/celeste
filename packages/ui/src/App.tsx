import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CommandPalette } from './components/CommandPalette';
import type { PaletteAction } from './components/CommandPalette';
import { Composer } from './components/Composer';
import { Icon } from './components/Icon';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Timeline } from './components/Timeline';
import { CelesteProvider } from './state/CelesteProvider';
import { useCeleste } from './state/useCeleste';
import { statusLabel } from './state/timeline';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const handler = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener('change', handler);
    return () => list.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

function Workspace() {
  const { state, actions, timeline, activeTask, effectiveApiBase } = useCeleste();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composerMode, setComposerMode] = useState<'reply' | 'new'>('reply');
  const [focusComposerToken, setFocusComposerToken] = useState(0);
  const narrow = useMediaQuery('(max-width: 900px)');
  const [sidebarOpen, setSidebarOpen] = useState(!narrow);
  const composerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSidebarOpen(!narrow);
  }, [narrow]);

  /* Global keyboard shortcuts. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (mod && event.key === 'Enter') {
        event.preventDefault();
        setComposerMode('new');
        setFocusComposerToken((token) => token + 1);
        const node = composerRef.current?.querySelector('textarea');
        node?.focus();
        return;
      }
      if (event.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen, settingsOpen]);

  const activeProvider = useMemo(
    () => state.providers.find((provider) => provider.id === state.health?.activeProvider) ??
      state.providers.find((provider) => provider.active) ??
      null,
    [state.providers, state.health],
  );

  const runningTasks = useMemo(
    () => state.sessions.filter((task) => task.status === 'running').length,
    [state.sessions],
  );

  const isRunning = activeTask?.status === 'running' || activeTask?.status === 'awaiting_approval';

  const handleSelectSession = useCallback(
    (id: string) => {
      actions.selectSession(id);
      setComposerMode('reply');
    },
    [actions],
  );

  const startNewTask = useCallback(() => {
    setComposerMode('new');
    setFocusComposerToken((token) => token + 1);
    const node = composerRef.current?.querySelector('textarea');
    node?.focus();
  }, []);

  const handleSend = useCallback(
    async (content: string) => {
      if (composerMode === 'new' || !state.activeSessionId) {
        await actions.createSession(content);
        setComposerMode('reply');
        return;
      }
      await actions.sendMessage(content);
    },
    [actions, composerMode, state.activeSessionId],
  );

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: 'new-session', label: 'New task', hint: 'Cmd/Ctrl+Enter', icon: 'plus', keywords: 'create start' },
      { id: 'toggle-theme', label: 'Toggle light / dark theme', icon: 'moon', keywords: 'appearance dark light' },
      {
        id: 'toggle-demo',
        label: state.connection === 'demo' ? 'Leave demo mode' : 'Enter demo mode',
        hint: 'Offline preview',
        icon: 'terminal',
        keywords: 'mock offline preview',
      },
      { id: 'reconnect', label: 'Reconnect to daemon', icon: 'refresh', keywords: 'reload retry connect' },
      { id: 'open-settings', label: 'Open settings', hint: 'Output dir, ports, providers', icon: 'settings' },
    ],
    [state.connection],
  );

  const runPaletteAction = useCallback(
    (id: string) => {
      switch (id) {
        case 'new-session':
          startNewTask();
          break;
        case 'toggle-theme':
          actions.setTheme(state.settings.theme === 'dark' ? 'light' : 'dark');
          break;
        case 'toggle-demo':
          void actions.toggleDemoMode();
          break;
        case 'reconnect':
          void actions.reconnect();
          break;
        case 'open-settings':
          setSettingsOpen(true);
          break;
        default:
          break;
      }
    },
    [actions, startNewTask, state.settings.theme],
  );

  return (
    <div className={`app${narrow ? ' app--narrow' : ''}`}>
      <header className="titlebar">
        <button
          type="button"
          className="icon-button titlebar__sidebar-toggle"
          onClick={() => setSidebarOpen((open) => !open)}
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          aria-expanded={sidebarOpen}
        >
          <Icon name="panel" size={16} />
        </button>

        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <Icon name="sparkle" size={15} />
          </span>
          <span className="brand__name">Celeste</span>
          <span className="brand__tag">local-first browser agent</span>
        </div>

        <div className="titlebar__spacer" />

        {state.connection === 'demo' ? (
          <span className="chip chip--demo" title="Running against the built-in mock daemon">
            <Icon name="terminal" size={11} />
            Demo
          </span>
        ) : null}

        <button
          type="button"
          className="icon-button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Open command palette"
          title="Command palette (Cmd/Ctrl+K)"
        >
          <Icon name="search" size={16} />
        </button>

        <button
          type="button"
          className="icon-button"
          onClick={() => actions.setTheme(state.settings.theme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle colour theme"
          title="Toggle theme"
        >
          <Icon name={state.settings.theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>

        <button
          type="button"
          className="icon-button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Open settings"
          title="Settings"
        >
          <Icon name="settings" size={16} />
        </button>
      </header>

      <div className="app__body">
        {sidebarOpen ? (
          <Sidebar
            sessions={state.sessions}
            activeId={state.activeSessionId}
            onSelect={handleSelectSession}
            onNew={startNewTask}
            onToggleCollapsed={() => setSidebarOpen(false)}
          />
        ) : null}

        <main className="main">
          <header className="session-head">
            <div className="session-head__title">
              <h1 className="session-head__name">
                {activeTask?.title ?? 'Celeste'}
              </h1>
              {activeTask ? (
                <span className={`pill pill--${activeTask.status}`}>{statusLabel(activeTask.status)}</span>
              ) : null}
              {activeProvider ? (
                <span className="badge badge--provider" title="Active provider and model">
                  <Icon name="sparkle" size={11} />
                  {activeProvider.label}
                  <span className="badge__sep">/</span>
                  {activeProvider.model}
                </span>
              ) : null}
              {activeTask && activeTask.artifacts.length > 0 ? (
                <span className="badge" title="Artifacts produced">
                  <Icon name="file" size={11} />
                  {activeTask.artifacts.length}
                </span>
              ) : null}
            </div>

            <div className="session-head__actions">
              {isRunning ? (
                <button type="button" className="button button--ghost" onClick={() => void actions.cancelTask()}>
                  <Icon name="stop" size={13} />
                  Stop task
                </button>
              ) : null}
              <button type="button" className="button button--ghost" onClick={startNewTask}>
                <Icon name="plus" size={13} />
                New task
              </button>
            </div>
          </header>

          <div className="main__timeline">
            <Timeline
              items={timeline}
              sessionId={state.activeSessionId}
              dismissedHumans={state.dismissedHumans}
              onDismissHuman={actions.dismissHuman}
              onRespondApproval={(requestId, decision) =>
                void actions.respondApproval(requestId, decision)
              }
              busy={state.busy}
              taskSources={activeTask?.sources}
              onAsk={(question) => void actions.sendMessage(question)}
            />
          </div>

          <div className="main__composer" ref={composerRef}>
            <Composer
              providers={state.providers}
              activeProviderId={activeProvider?.id ?? null}
              onProviderChange={(id) => void actions.switchProvider(id)}
              autoApprove={state.settings.autoApprove}
              onAutoApproveChange={(value) => actions.setSettings({ autoApprove: value })}
              onSend={handleSend}
              busy={state.busy}
              hasSession={state.activeSessionId !== null && composerMode === 'reply'}
              running={isRunning}
              onCancel={() => void actions.cancelTask()}
              focusToken={focusComposerToken}
              mode={composerMode}
            />
          </div>
        </main>
      </div>

      <StatusBar
        connection={state.connection}
        connectionError={state.connectionError}
        providerLabel={activeProvider?.label ?? null}
        model={activeProvider?.model ?? null}
        extensionConnected={state.extensionConnected}
        runningTasks={runningTasks}
        demoMode={state.connection === 'demo'}
        onToggleDemo={() => void actions.toggleDemoMode()}
        onReconnect={() => void actions.reconnect()}
        version={state.health?.version}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={state.sessions}
        providers={state.providers}
        actions={paletteActions}
        onSelectSession={handleSelectSession}
        onSelectProvider={(id) => void actions.switchProvider(id)}
        onRunAction={runPaletteAction}
      />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={state.settings}
        onChange={actions.setSettings}
        providers={state.providers}
        activeProviderId={activeProvider?.id ?? null}
        onSwitchProvider={(id) => void actions.switchProvider(id)}
        effectiveApiBase={effectiveApiBase}
      />

      <div className="toasts" role="status" aria-live="polite">
        {state.toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.kind}`}>
            <Icon
              name={
                toast.kind === 'error'
                  ? 'alert'
                  : toast.kind === 'warn'
                    ? 'alert'
                    : toast.kind === 'ok'
                      ? 'check-circle'
                      : 'info'
              }
              size={14}
            />
            <span>{toast.text}</span>
            <button
              type="button"
              className="icon-button icon-button--tiny"
              onClick={() => actions.dismissToast(toast.id)}
              aria-label="Dismiss notification"
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function App() {
  return (
    <CelesteProvider>
      <Workspace />
    </CelesteProvider>
  );
}
