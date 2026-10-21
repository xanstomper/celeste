import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, SearchFocus } from '@celeste/protocol';

import { BrowserWrapper } from './components/BrowserWrapper';
import { CanvasPane } from './components/CanvasPane';
import { CommandPalette } from './components/CommandPalette';
import type { PaletteAction } from './components/CommandPalette';
import { Composer } from './components/Composer';
import { Icon } from './components/Icon';
import { ProviderPicker } from './components/ProviderPicker';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { ThreadMenu } from './components/ThreadMenu';
import { Timeline } from './components/Timeline';
import { Wordmark } from './components/Wordmark';
import { usePanelMode, useMediaQuery } from './lib/panel';
import { CelesteProvider } from './state/CelesteProvider';
import { useCeleste } from './state/useCeleste';
import { statusLabel } from './state/timeline';
import { threadFileName, threadToMarkdown } from './lib/thread-export';

function Workspace() {
  const { state, actions, timeline, activeTask, effectiveApiBase } = useCeleste();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composerMode, setComposerMode] = useState<'reply' | 'new'>('reply');
  const [focus, setFocus] = useState<SearchFocus>('web');
  const [research, setResearch] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'browser' | 'canvas'>('chat');
  const [splitView, setSplitView] = useState(false);
  const [liveViewport, setLiveViewport] = useState(false);
  const [sidePane, setSidePane] = useState<'browser' | 'canvas'>('browser');
  const [canvasOpen, setCanvasOpen] = useState(false);
  const canvasSeenRef = useRef<string | null>(null);
  const [focusComposerToken, setFocusComposerToken] = useState(0);
  const [fill, setFill] = useState<{ text: string; token: number } | null>(null);
  const fillTokenRef = useRef(0);
  const narrow = useMediaQuery('(max-width: 900px)');
  const [sidebarOpen, setSidebarOpen] = useState(!narrow);
  const composerRef = useRef<HTMLDivElement | null>(null);

  /* Panel mode: docked next to a page, or a viewport too narrow for the
     full chrome. The session list and the status bar are noise there. */
  const panel = usePanelMode();

  useEffect(() => {
    setSidebarOpen(!narrow && !panel);
  }, [narrow, panel]);

  // A canvas that appears while the agent is working opens itself — that is
  // the moment it is meant to be seen. Re-opening a thread later leaves the
  // reader where they were.
  const canvasId = activeTask?.canvas?.id ?? null;
  useEffect(() => {
    if (canvasId && canvasId !== canvasSeenRef.current && activeTask?.status === 'running') {
      canvasSeenRef.current = canvasId;
      setSidePane('canvas');
      setSplitView(true);
    }
    if (!canvasId) canvasSeenRef.current = null;
  }, [canvasId, activeTask?.status]);

  // Keep the "ask about this page" chip honest: it must describe the page
  // that is open right now.
  useEffect(() => {
    void actions.refreshActiveTab();
    const timer = window.setInterval(() => {
      void actions.refreshActiveTab();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [actions]);

  // The live viewport streams frames of the page while the browser pane is
  // open. It costs nothing when the page is idle, and it is the difference
  // between a frozen screenshot and a window into what the agent sees.
  useEffect(() => {
    const wanted = splitView || activeTab === 'browser';
    if (wanted === liveViewport) return;
    setLiveViewport(wanted);
    if (wanted) {
      void actions.startViewport();
    } else {
      void actions.stopViewport();
    }
  }, [splitView, activeTab, liveViewport, actions]);

  // Auto-open live browser in split view on desktop when the agent starts browser actions!
  const hasBrowserAction = Boolean(activeTask?.activeBrowser);
  useEffect(() => {
    if (hasBrowserAction && !narrow && !splitView) {
      setSidePane('browser');
      setSplitView(true);
    }
  }, [hasBrowserAction, narrow, splitView]);

  const currentBrowserAction = activeTask?.activeBrowser ?? state.latestBrowserAction ?? null;
  const currentBrowserHistory =
    activeTask?.browserHistory && activeTask.browserHistory.length > 0
      ? activeTask.browserHistory
      : state.browserHistory;

  const handleOpenBrowser = useCallback(() => {
    setSidePane('browser');
    setSplitView(true);
  }, []);

  const handleOpenCanvas = useCallback(() => {
    setSidePane('canvas');
    setSplitView(true);
  }, []);

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
    actions.newTask();
    setComposerMode('new');
    setFocusComposerToken((token) => token + 1);
    const node = composerRef.current?.querySelector('textarea');
    node?.focus();
  }, [actions]);

  const handleSend = useCallback(
    async (content: string, attachments?: Attachment[]) => {
      if (composerMode === 'new' || !state.activeSessionId) {
        await actions.createSession(
          content,
          focus,
          research ? 'research' : undefined,
          attachments,
        );
        setComposerMode('reply');
        return;
      }
      await actions.sendMessage(content, attachments);
    },
    [actions, composerMode, focus, research, state.activeSessionId],
  );

  /** Saves the conversation as a Markdown file. */
  const exportThread = useCallback(() => {
    if (!activeTask) return;
    const markdown = threadToMarkdown(activeTask);
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = threadFileName(activeTask);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    actions.notify('ok', 'Thread exported as Markdown.');
  }, [actions, activeTask]);

  /** Drops a suggestion into the composer so the reader can edit it first. */
  const fillComposer = useCallback((text: string) => {
    fillTokenRef.current += 1;
    setFill({ text, token: fillTokenRef.current });
    setFocusComposerToken((token) => token + 1);
  }, []);

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
    <div className={`app${narrow ? ' app--narrow' : ''}${panel ? ' app--panel celeste-panel' : ''}`}>
      <header className="titlebar">
        {panel ? null : (
          <button
            type="button"
            className="icon-button titlebar__sidebar-toggle"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            aria-expanded={sidebarOpen}
          >
            <Icon name="panel" size={16} />
          </button>
        )}

        <Wordmark size={22} />

        {panel ? (
          <ThreadMenu
            sessions={state.sessions}
            activeId={state.activeSessionId}
            onSelect={handleSelectSession}
            onNew={startNewTask}
          />
        ) : null}

        <div className="titlebar__spacer" />

        {state.connection === 'demo' ? (
          <span className="chip chip--demo" title="Running against the built-in mock daemon">
            <Icon name="terminal" size={11} />
            Demo
          </span>
        ) : null}

        <ProviderPicker
          providers={state.providers}
          activeId={activeProvider?.id ?? null}
          onSwitch={(id) => void actions.switchProvider(id)}
          variant="pill"
          label="Active model"
        />

        <button
          type="button"
          className="icon-button"
          onClick={startNewTask}
          aria-label="New thread"
          title="New thread (Cmd/Ctrl+Enter)"
        >
          <Icon name="plus" size={16} />
        </button>

        <button
          type="button"
          className="icon-button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Open command palette"
          title={panel ? 'Command palette' : 'Command palette (Cmd/Ctrl+K)'}
        >
          <Icon name="search" size={16} />
        </button>

        {panel ? null : (
          <>
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
          </>
        )}
      </header>

      <div className="app__body">
        {sidebarOpen && !panel ? (
          <Sidebar
            sessions={state.sessions}
            activeId={state.activeSessionId}
            onSelect={handleSelectSession}
            onNew={startNewTask}
            onToggleCollapsed={() => setSidebarOpen(false)}
          />
        ) : null}

        <main className="main">
          {panel ? null : (
          <header className="session-head">
            <div className="session-head__title">
              <h1 className="session-head__name">
                {activeTask?.title ?? 'Celeste'}
              </h1>
              {activeTask && activeTask.status !== 'completed' ? (
                <span className={`pill pill--${activeTask.status}`}>{statusLabel(activeTask.status)}</span>
              ) : null}
              {activeProvider ? (
                <span
                  className="badge badge--provider"
                  title={`Active model: ${activeProvider.label} (${activeProvider.model})`}
                >
                  <Icon name="sparkle" size={11} />
                  {activeProvider.label}
                </span>
              ) : null}
              {activeTask && activeTask.artifacts.length > 0 ? (
                <span className="badge" title="Artifacts produced">
                  <Icon name="file" size={11} />
                  {activeTask.artifacts.length}
                </span>
              ) : null}
            </div>

            <div className="session-head__view-controls">
              <div className="segmented-tabs" role="tablist">
                <button
                  type="button"
                  className={`segmented-tab${activeTab === 'chat' && !splitView ? ' segmented-tab--active' : ''}`}
                  onClick={() => {
                    setActiveTab('chat');
                    setSplitView(false);
                  }}
                  role="tab"
                  aria-selected={activeTab === 'chat' && !splitView}
                >
                  <Icon name="bot" size={13} />
                  <span>Thread</span>
                </button>
                <button
                  type="button"
                  className={`segmented-tab${activeTab === 'browser' || (splitView && sidePane === 'browser') ? ' segmented-tab--active' : ''}`}
                  onClick={() => {
                    if (splitView) setSidePane('browser');
                    else setActiveTab('browser');
                  }}
                  role="tab"
                  aria-selected={activeTab === 'browser' || (splitView && sidePane === 'browser')}
                >
                  <Icon name="globe" size={13} />
                  <span>Live Browser</span>
                  {activeTask?.activeBrowser ? <span className="tab-dot" /> : null}
                </button>
                <button
                  type="button"
                  className={`segmented-tab${activeTab === 'canvas' || (splitView && sidePane === 'canvas') ? ' segmented-tab--active' : ''}`}
                  onClick={() => {
                    if (splitView) setSidePane('canvas');
                    else setActiveTab('canvas');
                  }}
                  role="tab"
                  aria-selected={activeTab === 'canvas' || (splitView && sidePane === 'canvas')}
                >
                  <Icon name="sparkle" size={13} />
                  <span>Canvas</span>
                  {activeTask?.canvas ? <span className="tab-dot" /> : null}
                </button>
              </div>

              <button
                type="button"
                className={`icon-button${splitView ? ' icon-button--accent' : ''}`}
                onClick={() => setSplitView((v) => !v)}
                title={splitView ? 'Close split view' : 'Open side-by-side split view'}
                aria-label="Toggle split view"
              >
                <Icon name="panel" size={14} />
              </button>
            </div>

            <div className="session-head__actions">
              {isRunning ? (
                <button type="button" className="button button--ghost" onClick={() => void actions.cancelTask()}>
                  <Icon name="stop" size={13} />
                  Stop task
                </button>
              ) : null}
              {activeTask ? (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={exportThread}
                  title="Save this conversation as Markdown"
                >
                  <Icon name="download" size={13} />
                  Export
                </button>
              ) : null}
              <button type="button" className="button button--ghost" onClick={startNewTask}>
                <Icon name="plus" size={13} />
                New task
              </button>
            </div>
          </header>
          )}

          {splitView ? (
            <div className="workspace-split">
              <div className="workspace-split__left">
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
                    onFill={fillComposer}
                    onOpenCanvas={handleOpenCanvas}
                    onOpenBrowser={handleOpenBrowser}
                  />
                </div>

                <div className="main__composer" ref={composerRef}>
                  <Composer
                    providers={state.providers}
                    activeProviderId={activeProvider?.id ?? null}
                    onProviderChange={(id) => void actions.switchProvider(id)}
                    autoApprove={state.settings.autoApprove}
                    onAutoApproveChange={(value) => actions.setSettings({ autoApprove: value })}
                    focus={focus}
                    onFocusChange={setFocus}
                    research={research}
                    onResearchChange={setResearch}
                    onSend={handleSend}
                    onNotice={(message) => actions.notify('warn', message)}
                    page={state.activeTab}
                    busy={state.busy}
                    hasSession={state.activeSessionId !== null && composerMode === 'reply'}
                    running={isRunning}
                    onCancel={() => void actions.cancelTask()}
                    focusToken={focusComposerToken}
                    mode={composerMode}
                    fill={fill}
                  />
                </div>
              </div>

              <div className="workspace-split__right">
                {sidePane === 'browser' ? (
                  <BrowserWrapper
                    activeAction={currentBrowserAction}
                    frame={state.viewportFrame}
                    browserHistory={currentBrowserHistory}
                    extensionConnected={state.extensionConnected}
                    onClose={() => setSplitView(false)}
                    onNavigate={(url) => void actions.navigateBrowser(url)}
                    onClick={(point, ref) => void actions.clickBrowser(point, ref)}
                    onType={(text, ref) => void actions.typeBrowser(text, ref)}
                    onScroll={(deltaY) => void actions.scrollBrowser(deltaY)}
                    onCaptureScreenshot={() => actions.captureScreenshot()}
                    onListTabs={actions.listTabs}
                    onSwitchTab={actions.switchTab}
                    onAsk={(prompt) => void actions.sendMessage(prompt)}
                  />
                ) : (
                  <CanvasPane
                    key={activeTask?.canvas?.id ?? 'canvas-empty'}
                    canvas={activeTask?.canvas ?? null}
                    onClose={() => setSplitView(false)}
                    onAsk={(prompt) => void actions.sendMessage(prompt)}
                  />
                )}
              </div>
            </div>
          ) : activeTab === 'browser' ? (
            <div className="main__full-pane">
              <BrowserWrapper
                activeAction={currentBrowserAction}
                browserHistory={currentBrowserHistory}
                extensionConnected={state.extensionConnected}
                onClose={() => setActiveTab('chat')}
                onNavigate={(url) => void actions.navigateBrowser(url)}
                onClick={(point, ref) => void actions.clickBrowser(point, ref)}
                onType={(text, ref) => void actions.typeBrowser(text, ref)}
                onScroll={(deltaY) => void actions.scrollBrowser(deltaY)}
                onCaptureScreenshot={() => actions.captureScreenshot()}
                onAsk={(prompt) => void actions.sendMessage(prompt)}
              />
            </div>
          ) : activeTab === 'canvas' ? (
            <div className="main__full-pane">
              <CanvasPane
                key={activeTask?.canvas?.id ?? 'canvas-empty'}
                canvas={activeTask?.canvas ?? null}
                onClose={() => setActiveTab('chat')}
                onAsk={(prompt) => {
                  setActiveTab('chat');
                  void actions.sendMessage(prompt);
                }}
              />
            </div>
          ) : (
            <>
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
                  onFill={fillComposer}
                  onOpenCanvas={handleOpenCanvas}
                  onOpenBrowser={handleOpenBrowser}
                />
              </div>

              <div className="main__composer" ref={composerRef}>
                <Composer
                  providers={state.providers}
                  activeProviderId={activeProvider?.id ?? null}
                  onProviderChange={(id) => void actions.switchProvider(id)}
                  autoApprove={state.settings.autoApprove}
                  onAutoApproveChange={(value) => actions.setSettings({ autoApprove: value })}
                  focus={focus}
                  onFocusChange={setFocus}
                  research={research}
                  onResearchChange={setResearch}
                  onSend={handleSend}
                  busy={state.busy}
                  hasSession={state.activeSessionId !== null && composerMode === 'reply'}
                  running={isRunning}
                  onCancel={() => void actions.cancelTask()}
                  focusToken={focusComposerToken}
                  mode={composerMode}
                  fill={fill}
                />
              </div>
            </>
          )}
        </main>
      </div>

      {panel ? null : (
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
      )}

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
