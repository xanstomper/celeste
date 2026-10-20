import { useState } from 'react';
import { formatDuration, humanizeToolName } from '../lib/format';
import type { ToolTimelineItem } from '../state/timeline';
import { Icon } from './Icon';
import { JsonView } from './JsonView';

export interface ToolCardProps {
  item: ToolTimelineItem;
  runtimeHint?: string;
  onOpenBrowser?: () => void;
}

function statusIcon(status: ToolTimelineItem['status']) {
  if (status === 'running') return <Icon name="spinner" size={14} />;
  if (status === 'ok') return <Icon name="check" size={14} />;
  return <Icon name="x" size={14} />;
}

export function ToolCard({ item, runtimeHint, onOpenBrowser }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const [zoomImage, setZoomImage] = useState(false);

  const stateClass = item.status === 'ok' ? 'ok' : item.status === 'error' ? 'error' : 'running';
  const hasDetail =
    Object.keys(item.arguments ?? {}).length > 0 || item.data !== undefined || item.error !== undefined;

  const isBrowser = item.toolName.startsWith('browser_');
  const isSearch = item.toolName === 'web_search';

  // Extract screenshot if present in tool data
  const dataObj =
    item.data && typeof item.data === 'object' ? (item.data as Record<string, unknown>) : null;
  const imageBase64 =
    (dataObj?.imageBase64 as string | undefined) ?? (dataObj?.screenshot as string | undefined);
  const clickPoint = dataObj?.point as { x: number; y: number } | undefined;
  const clickElement = dataObj?.element as { tag?: string; text?: string } | undefined;
  const clickRef = (dataObj?.ref as string | undefined) ?? (item.arguments?.ref as string | undefined);
  const navUrl =
    (dataObj?.url as string | undefined) ?? (item.arguments?.url as string | undefined);
  const typedText =
    (dataObj?.typed as string | undefined) ?? (item.arguments?.text as string | undefined);

  return (
    <article
      className={`tool-card tool-card--${stateClass}${isBrowser ? ' tool-card--browser' : ''}`}
      data-tool={item.toolName}
    >
      <button
        type="button"
        className="tool-card__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`tool-card__status tool-card__status--${stateClass}`}>
          {statusIcon(item.status)}
        </span>

        {/* Specialized tool badges */}
        {isBrowser ? (
          <span className="tool-card__browser-badge" title="Browser Action">
            <Icon name="globe" size={12} />
          </span>
        ) : isSearch ? (
          <span className="tool-card__browser-badge" title="Web Search">
            <Icon name="search" size={12} />
          </span>
        ) : null}

        <span className="tool-card__name">{humanizeToolName(item.toolName)}</span>
        {runtimeHint ? <span className="chip chip--ghost">{runtimeHint}</span> : null}

        {/* Specialized inline visual summary */}
        {item.toolName === 'browser_navigate' && navUrl ? (
          <span className="tool-card__omnibox-preview" title={navUrl}>
            <Icon name="lock" size={10} />
            <span className="tool-card__omnibox-url">{navUrl}</span>
          </span>
        ) : item.toolName === 'browser_click' && (clickPoint || clickRef) ? (
          <span className="tool-card__click-preview">
            <Icon name="cursor" size={11} />
            {clickRef ? <strong className="tool-card__click-ref">[{clickRef}]</strong> : null}
            {clickElement?.tag ? <span>&lt;{clickElement.tag}&gt;</span> : null}
            {clickElement?.text ? <em>"{clickElement.text.slice(0, 30)}"</em> : null}
            {clickPoint ? (
              <span className="tool-card__coords">
                ({Math.round(clickPoint.x)}, {Math.round(clickPoint.y)})
              </span>
            ) : null}
          </span>
        ) : item.toolName === 'browser_type' && typedText ? (
          <span className="tool-card__type-preview">
            <span className="tool-card__type-bubble">"{typedText.slice(0, 45)}"</span>
          </span>
        ) : (
          <span className="tool-card__summary">{item.summary}</span>
        )}

        <span className="tool-card__meta">
          {item.status === 'running' ? (
            <span className="tool-card__duration tool-card__duration--live">running</span>
          ) : (
            <span className="tool-card__duration">{formatDuration(item.durationMs)}</span>
          )}
          {hasDetail ? (
            <Icon
              name={open ? 'chevron-down' : 'chevron-right'}
              size={14}
              className="tool-card__chevron"
            />
          ) : null}
        </span>
      </button>

      {/* Embedded screenshot preview for browser actions */}
      {imageBase64 && (
        <div className="tool-card__screenshot-strip">
          <div className="tool-card__screenshot-thumb" onClick={() => setZoomImage(true)}>
            <img src={`data:image/jpeg;base64,${imageBase64}`} alt="Page view" />
            <span className="tool-card__screenshot-overlay">
              <Icon name="eye" size={12} /> View Page
            </span>
          </div>
        </div>
      )}

      {open ? (
        <div className="tool-card__body">
          {/* Action shortcut to switch to Live Browser */}
          {isBrowser && onOpenBrowser ? (
            <div className="tool-card__quick-jump">
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={onOpenBrowser}
              >
                <Icon name="globe" size={12} />
                Open in Live Browser Viewport
              </button>
            </div>
          ) : null}

          <section className="tool-card__section">
            <h4 className="tool-card__label">
              <Icon name="terminal" size={12} />
              Arguments
            </h4>
            <JsonView value={item.arguments} emptyLabel="No arguments" maxHeight={260} />
          </section>

          {item.error ? (
            <section className="tool-card__section">
              <h4 className="tool-card__label tool-card__label--error">
                <Icon name="alert" size={12} />
                Error
              </h4>
              <div className="tool-error">
                <code className="tool-error__code">{item.error.code}</code>
                <span className="tool-error__message">{item.error.message}</span>
              </div>
            </section>
          ) : null}

          {item.data !== undefined ? (
            <section className="tool-card__section">
              <h4 className="tool-card__label">
                <Icon name="sparkle" size={12} />
                Result
              </h4>
              <JsonView value={item.data} maxHeight={280} />
            </section>
          ) : null}
        </div>
      ) : null}

      {/* Full zoom modal for screenshot */}
      {zoomImage && imageBase64 ? (
        <div className="browser-zoom-modal" onClick={() => setZoomImage(false)}>
          <div className="browser-zoom-modal__content" onClick={(e) => e.stopPropagation()}>
            <header className="browser-zoom-modal__head">
              <span>{item.summary || 'Browser Screenshot'}</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setZoomImage(false)}
                aria-label="Close zoom"
              >
                <Icon name="x" size={16} />
              </button>
            </header>
            <div className="browser-zoom-modal__body">
              <img src={`data:image/jpeg;base64,${imageBase64}`} alt="Full page view" />
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
