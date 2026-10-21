import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserActionInfo } from '@celeste/protocol';
import { Icon } from './Icon';

export interface BrowserWrapperProps {
  activeAction?: BrowserActionInfo | null;
  browserHistory?: BrowserActionInfo[];
  extensionConnected?: boolean;
  onClose?: () => void;
  onNavigate?: (url: string) => Promise<void> | void;
  onClick?: (point: { x: number; y: number }, ref?: string) => Promise<void> | void;
  onType?: (text: string, ref?: string) => Promise<void> | void;
  onScroll?: (deltaY: number) => Promise<void> | void;
  onCaptureScreenshot?: () => Promise<string | void> | void;
  onAsk?: (prompt: string) => Promise<void> | void;
}

export function BrowserWrapper({
  activeAction,
  browserHistory = [],
  extensionConnected = true,
  onClose,
  onNavigate,
  onClick,
  onType,
  onScroll,
  onCaptureScreenshot,
  onAsk,
}: BrowserWrapperProps) {
  const [urlInput, setUrlInput] = useState('');
  const [selectedActionIndex, setSelectedActionIndex] = useState<number | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [zoomModal, setZoomModal] = useState(false);
  const [showTypeInput, setShowTypeInput] = useState(false);
  const [typeText, setTypeText] = useState('');
  const [userRipple, setUserRipple] = useState<{ x: number; y: number; time: number } | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

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
      if (!/^https?:\/\//i.test(target) && !target.startsWith('about:')) {
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

  // Forward clicks from the live viewport image directly to the web browser
  const handleViewportClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      const scaleX = (e.currentTarget.naturalWidth || rect.width) / rect.width;
      const scaleY = (e.currentTarget.naturalHeight || rect.height) / rect.height;
      const targetX = Math.round(clickX * scaleX);
      const targetY = Math.round(clickY * scaleY);

      setUserRipple({ x: clickX, y: clickY, time: Date.now() });
      onClick?.({ x: targetX, y: targetY });
    },
    [onClick],
  );

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

  // Formulate real-time action description
  const actionDescription = useMemo(() => {
    if (!displayedAction) return 'Autonomous Web Engine Ready';
    switch (displayedAction.action) {
      case 'click':
        return `Clicking ${displayedAction.ref ? `[${displayedAction.ref}]` : ''} ${
          displayedAction.element?.tag ? `<${displayedAction.element.tag}>` : ''
        } ${displayedAction.element?.text ? `"${displayedAction.element.text}"` : ''} at (${Math.round(
          displayedAction.point?.x ?? 0,
        )}, ${Math.round(displayedAction.point?.y ?? 0)})`;
      case 'type':
        return `Typing into ${displayedAction.ref ? `[${displayedAction.ref}]` : 'input'}: "${displayedAction.text}"`;
      case 'navigate':
        return `Navigating to ${displayedAction.url}`;
      case 'snapshot':
        return `Reading and analyzing page DOM elements (${displayedAction.title || 'Page'})`;
      default:
        return displayedAction.title || displayedAction.url || 'Operating live browser';
    }
  }, [displayedAction]);

  return (
    <section className="browser-wrapper" aria-label="Perplexity Live Web Wrapper">
      {/* 1. Browser Window Chrome & Omnibox */}
      <header className="browser-wrapper__chrome">
        <div className="browser-wrapper__nav">
          <button
            type="button"
            className="icon-button icon-button--sm"
            onClick={() => onNavigate?.('about:blank')}
            title="Home"
            aria-label="Home"
          >
            <Icon name="globe" size={13} />
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
          <button
            type="button"
            className="icon-button icon-button--sm"
            onClick={() => onScroll?.(-400)}
            title="Scroll up"
            aria-label="Scroll up"
          >
            <Icon name="chevron-up" size={13} />
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm"
            onClick={() => onScroll?.(400)}
            title="Scroll down"
            aria-label="Scroll down"
          >
            <Icon name="chevron-down" size={13} />
          </button>
          <button
            type="button"
            className={`icon-button icon-button--sm${showTypeInput ? ' icon-button--accent' : ''}`}
            onClick={() => setShowTypeInput((v) => !v)}
            title="Type text into active browser element"
            aria-label="Type text into page"
          >
            <Icon name="terminal" size={13} />
          </button>
          {displayedAction?.screenshot ? (
            <button
              type="button"
              className="icon-button icon-button--sm"
              onClick={() => setZoomModal(true)}
              title="Fullscreen inspector"
              aria-label="Fullscreen inspector"
            >
              <Icon name="search" size={13} />
            </button>
          ) : null}
        </div>

        {/* Address Bar / Omnibox */}
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
            placeholder="Search the live web or enter URL…"
          />
          <button
            type="submit"
            className="browser-wrapper__go-btn"
            title="Navigate to URL"
          >
            Go
          </button>
        </form>

        {/* Browser Engine Status & Quick Actions */}
        <div className="browser-wrapper__actions">
          <div
            className="browser-status-pill browser-status-pill--active"
            title="Autonomous Web Engine active (direct browser control)"
          >
            <span className="browser-status-pill__dot" />
            <span className="browser-status-pill__label">Web Engine</span>
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

      {/* Direct User Keystroke Injection Bar */}
      {showTypeInput ? (
        <form
          className="browser-wrapper__type-bar"
          onSubmit={(e) => {
            e.preventDefault();
            const text = typeText.trim();
            if (text) {
              onType?.(text);
              setTypeText('');
              setShowTypeInput(false);
            }
          }}
        >
          <span className="type-bar__label">Send Keys:</span>
          <input
            type="text"
            className="type-bar__input"
            value={typeText}
            onChange={(e) => setTypeText(e.target.value)}
            placeholder="Type text to send to focused element and press Enter…"
            autoFocus
          />
          <button type="submit" className="button button--primary button--sm">
            Send
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm"
            onClick={() => setShowTypeInput(false)}
            aria-label="Cancel"
          >
            <Icon name="x" size={12} />
          </button>
        </form>
      ) : null}

      {/* 2. Omnibox Quick Actions Bar (Perplexity Style) */}
      <div className="browser-wrapper__quick-bar">
        <span className="quick-bar__label">Page Actions:</span>
        <button
          type="button"
          className="quick-bar__chip"
          onClick={() =>
            onAsk?.(
              `Summarize the key findings and content on ${displayedAction?.url || 'this page'} concisely.`,
            )
          }
          title="Summarize current page"
        >
          <Icon name="file" size={11} />
          <span>Summarize</span>
        </button>
        <button
          type="button"
          className="quick-bar__chip"
          onClick={() =>
            onAsk?.(
              `Perform Deep Research starting from ${displayedAction?.url || 'this page'} and compile a structured report.`,
            )
          }
          title="Deep Research from this page"
        >
          <Icon name="sparkle" size={11} />
          <span>Deep Research</span>
        </button>
        <button
          type="button"
          className="quick-bar__chip"
          onClick={() =>
            onAsk?.(
              `Extract all links, pricing, tables, and structured data from ${displayedAction?.url || 'this page'}.`,
            )
          }
          title="Extract data from page"
        >
          <Icon name="list" size={11} />
          <span>Extract Data</span>
        </button>
      </div>

      {/* 3. Live Screen Viewport (Interactive Web Wrapper) */}
      <div className="browser-wrapper__viewport">
        {displayedAction?.screenshot ? (
          <div className="browser-viewport__canvas-wrap">
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${displayedAction.screenshot}`}
              alt={displayedAction.title || 'Live Web Viewport'}
              className="browser-viewport__img"
              onClick={handleViewportClick}
              title="Interactive viewport — click anywhere to interact with the webpage"
            />

            {/* User Click Feedback Ripple */}
            {userRipple ? (
              <div
                className="browser-viewport__user-ripple"
                key={userRipple.time}
                style={{
                  left: `${userRipple.x}px`,
                  top: `${userRipple.y}px`,
                }}
              />
            ) : null}

            {/* Agent Animated Cursor Visualizer */}
            {displayedAction.action === 'click' && displayedAction.point ? (
              <div
                className="browser-viewport__cursor"
                style={{
                  left: `${displayedAction.point.x}px`,
                  top: `${displayedAction.point.y}px`,
                }}
              >
                <div className="browser-viewport__cursor-pointer">
                  <Icon name="cursor" size={16} />
                  <span className="browser-viewport__cursor-badge">Celeste</span>
                </div>
                <div className="browser-viewport__cursor-pulse" />
                <div className="browser-viewport__cursor-tooltip">
                  <span>
                    Clicked {displayedAction.ref ? `[${displayedAction.ref}]` : ''} at (
                    {Math.round(displayedAction.point.x)}, {Math.round(displayedAction.point.y)})
                  </span>
                </div>
              </div>
            ) : null}

            {/* Agent Typing Visualizer */}
            {displayedAction.action === 'type' && displayedAction.text ? (
              <div
                className="browser-viewport__typing-bubble"
                style={{
                  left: displayedAction.point ? `${displayedAction.point.x}px` : '40%',
                  top: displayedAction.point ? `${displayedAction.point.y - 36}px` : '30%',
                }}
              >
                <span className="typing-bubble__label">Celeste typing:</span>
                <span className="typing-bubble__text">&ldquo;{displayedAction.text}&rdquo;</span>
                <span className="typing-bubble__cursor" />
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
            <h3 className="browser-viewport__blank-title">Perplexity Live Web Wrapper</h3>
            <p className="browser-viewport__blank-sub">
              Celeste runs an autonomous browser engine directly. When you or Celeste browse, click,
              or extract data, the live interactive viewport and action tracking render right here in real time.
            </p>
            <div className="browser-viewport__quick-links">
              <button
                type="button"
                className="chip chip--ghost"
                onClick={() => onNavigate?.('https://en.wikipedia.org')}
              >
                Wikipedia
              </button>
              <button
                type="button"
                className="chip chip--ghost"
                onClick={() => onNavigate?.('https://arxiv.org')}
              >
                arXiv
              </button>
              <button
                type="button"
                className="chip chip--ghost"
                onClick={() => onNavigate?.('https://news.ycombinator.com')}
              >
                Hacker News
              </button>
            </div>
          </div>
        )}

        {/* Live Perplexity-Style Action Ticker Banner */}
        <div className="browser-viewport__action-banner">
          <span className="live-ticker__pulse" />
          <span className="action-badge action-badge--active">
            {displayedAction?.action ? displayedAction.action.toUpperCase() : 'BROWSER READY'}
          </span>
          <span className="browser-viewport__action-desc">{actionDescription}</span>
          {displayedAction?.at ? (
            <span className="browser-viewport__action-time">
              {new Date(displayedAction.at).toLocaleTimeString()}
            </span>
          ) : null}
        </div>
      </div>

      {/* 4. Action History Drawer */}
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
                  key={`${item.at}-${idx}`}
                  className={`history-card${active ? ' history-card--active' : ''}`}
                  onClick={() => setSelectedActionIndex(idx)}
                  title={`${item.action} at ${new Date(item.at).toLocaleTimeString()}`}
                >
                  <span className={`history-card__badge history-card__badge--${item.action}`}>
                    {item.action}
                  </span>
                  <span className="history-card__title">
                    {item.action === 'click' && item.point
                      ? `Click (${Math.round(item.point.x)}, ${Math.round(item.point.y)})`
                      : item.title || item.url || item.text || 'Action'}
                  </span>
                </button>
              );
            })}
          </div>
        </footer>
      ) : null}

      {/* 5. Fullscreen Zoom Modal */}
      {zoomModal && displayedAction?.screenshot ? (
        <div className="modal-backdrop" onClick={() => setZoomModal(false)}>
          <div className="modal-dialog modal-dialog--fullscreen" onClick={(e) => e.stopPropagation()}>
            <div className="modal-dialog__head">
              <h3>{displayedAction.title || 'Screen Inspector'}</h3>
              <button
                type="button"
                className="icon-button icon-button--sm"
                onClick={() => setZoomModal(false)}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="modal-dialog__body modal-dialog__body--img">
              <img
                src={`data:image/jpeg;base64,${displayedAction.screenshot}`}
                alt="Fullscreen Viewport"
              />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
