import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BrowserActionInfo } from '@celeste/protocol';
import { Icon } from './Icon';

export interface BrowserWrapperProps {
  activeAction?: BrowserActionInfo | null;
  browserHistory?: BrowserActionInfo[];
  extensionConnected: boolean;
  onClose?: () => void;
  onNavigate?: (url: string) => Promise<void> | void;
  onCaptureScreenshot?: () => Promise<string | void> | void;
}

export function BrowserWrapper({
  activeAction,
  browserHistory = [],
  extensionConnected,
  onClose,
  onNavigate,
  onCaptureScreenshot,
}: BrowserWrapperProps) {
  const [urlInput, setUrlInput] = useState('');
  const [selectedActionIndex, setSelectedActionIndex] = useState<number | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [zoomModal, setZoomModal] = useState(false);

  // The active action to display (either the latest or user-selected from history)
  const displayedAction = useMemo(() => {
    if (selectedActionIndex !== null && browserHistory[selectedActionIndex]) {
      return browserHistory[selectedActionIndex];
    }
    return activeAction ?? browserHistory[browserHistory.length - 1] ?? null;
  }, [activeAction, browserHistory, selectedActionIndex]);

  // Keep URL bar in sync with active action
  useEffect(() => {
    if (displayedAction?.url) {
      setUrlInput(displayedAction.url);
    }
  }, [displayedAction?.url]);

  const handleSubmitUrl = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      let target = urlInput.trim();
      if (!target) return;
      if (!/^https?:\/\//i.test(target)) {
        target = `https://${target}`;
      }
      onNavigate?.(target);
    },
    [onNavigate, urlInput],
  );

  const handleCapture = useCallback(async () => {
    if (!onCaptureScreenshot || isCapturing) return;
    setIsCapturing(true);
    try {
      await onCaptureScreenshot();
    } finally {
      setIsCapturing(false);
    }
  }, [onCaptureScreenshot, isCapturing]);

  // Parse hostname for neat omnibox display
  const displayHost = useMemo(() => {
    if (!displayedAction?.url) return 'New Tab';
    try {
      const u = new URL(displayedAction.url);
      return u.hostname;
    } catch {
      return displayedAction.url;
    }
  }, [displayedAction?.url]);

  return (
    <section className="browser-wrapper" aria-label="Live Browser">
      {/* 1. Browser Window Chrome & Omnibox */}
      <header className="browser-wrapper__chrome">
        <div className="browser-wrapper__nav">
          <button
            type="button"
            className="icon-button icon-button--sm"
            title="Back"
            aria-label="Back"
            disabled
          >
            <Icon name="chevron-left" size={13} />
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm"
            title="Forward"
            aria-label="Forward"
            disabled
          >
            <Icon name="chevron-right" size={13} />
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm"
            onClick={handleCapture}
            title="Refresh screenshot"
            aria-label="Refresh screenshot"
          >
            <Icon name={isCapturing ? 'spinner' : 'refresh'} size={13} />
          </button>
        </div>

        {/* Address Bar */}
        <form className="browser-wrapper__omnibox" onSubmit={handleSubmitUrl}>
          <span className="browser-wrapper__lock" title="Secure connection">
            <Icon name="lock" size={12} />
          </span>
          <span className="browser-wrapper__host-pill">{displayHost}</span>
          <input
            type="text"
            className="browser-wrapper__url-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter URL or search query…"
          />
          <button
            type="submit"
            className="browser-wrapper__go-btn"
            title="Navigate"
            disabled={!extensionConnected}
          >
            Go
          </button>
        </form>

        {/* Extension Connection & Controls */}
        <div className="browser-wrapper__actions">
          <div
            className={`browser-status-pill ${
              extensionConnected ? 'browser-status-pill--active' : 'browser-status-pill--offline'
            }`}
            title={
              extensionConnected
                ? 'Connected to your browser via Celeste extension'
                : 'Extension disconnected'
            }
          >
            <span className="browser-status-pill__dot" />
            <span className="browser-status-pill__label">
              {extensionConnected ? 'Brave' : 'Offline'}
            </span>
          </div>

          {displayedAction?.url ? (
            <a
              href={displayedAction.url}
              target="_blank"
              rel="noreferrer"
              className="icon-button icon-button--sm"
              title="Open in native browser tab"
              aria-label="Open in native browser tab"
            >
              <Icon name="external" size={13} />
            </a>
          ) : null}

          {onClose ? (
            <button
              type="button"
              className="icon-button icon-button--sm"
              onClick={onClose}
              title="Close browser view"
              aria-label="Close browser view"
            >
              <Icon name="x" size={14} />
            </button>
          ) : null}
        </div>
      </header>

      {/* 2. Live Screen Viewport */}
      <div className="browser-wrapper__viewport">
        {displayedAction?.screenshot ? (
          <div className="browser-viewport__canvas-wrap">
            <img
              src={`data:image/jpeg;base64,${displayedAction.screenshot}`}
              alt={displayedAction.title || 'Browser Viewport'}
              className="browser-viewport__img"
              onClick={() => setZoomModal(true)}
              title="Click to zoom screenshot"
            />

            {/* Click Ripple & Cursor Visualizer */}
            {displayedAction.action === 'click' && displayedAction.point ? (
              <div
                className="browser-viewport__cursor"
                style={{
                  left: `${displayedAction.point.x}px`,
                  top: `${displayedAction.point.y}px`,
                }}
              >
                <div className="browser-viewport__cursor-dot" />
                <div className="browser-viewport__cursor-pulse" />
                <div className="browser-viewport__cursor-tooltip">
                  <Icon name="cursor" size={11} />
                  <span>
                    Clicked {displayedAction.ref ? `[${displayedAction.ref}]` : ''} at (
                    {Math.round(displayedAction.point.x)}, {Math.round(displayedAction.point.y)})
                  </span>
                </div>
              </div>
            ) : null}

            {/* Bounding box around clicked/targeted element if available */}
            {displayedAction.element?.box ? (
              <div
                className="browser-viewport__element-box"
                style={{
                  left: `${displayedAction.element.box.x}px`,
                  top: `${displayedAction.element.box.y}px`,
                  width: `${displayedAction.element.box.width}px`,
                  height: `${displayedAction.element.box.height}px`,
                }}
              >
                <span className="browser-viewport__element-tag">
                  &lt;{displayedAction.element.tag}&gt;{' '}
                  {displayedAction.element.text ? `"${displayedAction.element.text}"` : ''}
                </span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="browser-viewport__blank">
            <div className="browser-viewport__blank-icon">
              <Icon name="globe" size={32} />
            </div>
            <h3 className="browser-viewport__blank-title">Live Browser Viewport</h3>
            <p className="browser-viewport__blank-sub">
              {extensionConnected
                ? 'Ready. When Celeste searches the web, navigates pages, or clicks buttons, you will see the live browser screen and click actions right here.'
                : 'Celeste drives your real browser via the Celeste browser extension. Connect the extension to enable live screen viewing and clicking.'}
            </p>
            <div className="browser-viewport__quick-links">
              <button
                type="button"
                className="chip chip--ghost"
                onClick={() => onNavigate?.('https://en.wikipedia.org')}
                disabled={!extensionConnected}
              >
                Wikipedia
              </button>
              <button
                type="button"
                className="chip chip--ghost"
                onClick={() => onNavigate?.('https://arxiv.org')}
                disabled={!extensionConnected}
              >
                arXiv
              </button>
              <button
                type="button"
                className="chip chip--ghost"
                onClick={() => onNavigate?.('https://news.ycombinator.com')}
                disabled={!extensionConnected}
              >
                Hacker News
              </button>
            </div>
          </div>
        )}

        {/* Live Action Ticker Banner */}
        {displayedAction ? (
          <div className="browser-viewport__action-banner">
            <span className={`action-badge action-badge--${displayedAction.action}`}>
              {displayedAction.action.toUpperCase()}
            </span>
            <span className="browser-viewport__action-desc">
              {displayedAction.action === 'click' && displayedAction.point
                ? `Clicking ${displayedAction.ref ? `[${displayedAction.ref}]` : ''} ${
                    displayedAction.element?.tag ? `<${displayedAction.element.tag}>` : ''
                  } ${displayedAction.element?.text ? `"${displayedAction.element.text}"` : ''} at (${Math.round(
                    displayedAction.point.x,
                  )}, ${Math.round(displayedAction.point.y)})`
                : displayedAction.action === 'type'
                ? `Typing text into [${displayedAction.ref}]: "${displayedAction.text}"`
                : displayedAction.action === 'navigate'
                ? `Navigated to ${displayedAction.url}`
                : displayedAction.title || displayedAction.url || 'Operating browser'}
            </span>
            <span className="browser-viewport__action-time">
              {new Date(displayedAction.at).toLocaleTimeString()}
            </span>
          </div>
        ) : null}
      </div>

      {/* 3. Action History Drawer */}
      {browserHistory.length > 0 ? (
        <footer className="browser-wrapper__history">
          <div className="browser-wrapper__history-head">
            <span className="browser-wrapper__history-title">
              <Icon name="list" size={11} />
              Activity Log ({browserHistory.length})
            </span>
            {selectedActionIndex !== null ? (
              <button
                type="button"
                className="browser-wrapper__history-reset"
                onClick={() => setSelectedActionIndex(null)}
              >
                Show latest
              </button>
            ) : null}
          </div>
          <div className="browser-wrapper__history-strip">
            {browserHistory.map((item, idx) => {
              const active =
                selectedActionIndex === idx ||
                (selectedActionIndex === null && idx === browserHistory.length - 1);
              return (
                <button
                  type="button"
                  key={item.id || idx}
                  className={`history-pill${active ? ' history-pill--active' : ''}`}
                  onClick={() => setSelectedActionIndex(idx)}
                >
                  <span className={`history-pill__dot history-pill__dot--${item.action}`} />
                  <span className="history-pill__type">{item.action}</span>
                  {item.ref ? <span className="history-pill__ref">{item.ref}</span> : null}
                </button>
              );
            })}
          </div>
        </footer>
      ) : null}

      {/* High-res Zoom Modal */}
      {zoomModal && displayedAction?.screenshot ? (
        <div className="browser-zoom-modal" onClick={() => setZoomModal(false)}>
          <div className="browser-zoom-modal__content" onClick={(e) => e.stopPropagation()}>
            <header className="browser-zoom-modal__head">
              <span>{displayedAction.title || displayedAction.url || 'Full Viewport'}</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setZoomModal(false)}
                aria-label="Close zoom"
              >
                <Icon name="x" size={16} />
              </button>
            </header>
            <div className="browser-zoom-modal__body">
              <img
                src={`data:image/jpeg;base64,${displayedAction.screenshot}`}
                alt="Zoomed Viewport"
              />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
