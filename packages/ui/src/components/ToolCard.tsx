import { useState } from 'react';

import { formatDuration, humanizeToolName } from '../lib/format';
import type { ToolTimelineItem } from '../state/timeline';
import { Icon } from './Icon';
import { JsonView } from './JsonView';

export interface ToolCardProps {
  item: ToolTimelineItem;
  /** Rendered next to the tool name (e.g. the runtime badge). */
  runtimeHint?: string;
}

function statusIcon(status: ToolTimelineItem['status']) {
  if (status === 'running') return <Icon name="spinner" size={14} />;
  if (status === 'ok') return <Icon name="check" size={14} />;
  return <Icon name="x" size={14} />;
}

/**
 * A collapsible card for a single tool invocation.
 *
 * Collapsed it shows the tool name, a one line summary and the duration.
 * Expanded it reveals the exact JSON arguments and the structured result.
 */
export function ToolCard({ item, runtimeHint }: ToolCardProps) {
  const [open, setOpen] = useState(false);

  const stateClass = item.status === 'ok' ? 'ok' : item.status === 'error' ? 'error' : 'running';
  const hasDetail =
    Object.keys(item.arguments ?? {}).length > 0 || item.data !== undefined || item.error !== undefined;

  return (
    <article className={`tool-card tool-card--${stateClass}`} data-tool={item.toolName}>
      <button
        type="button"
        className="tool-card__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`tool-card__status tool-card__status--${stateClass}`}>
          {statusIcon(item.status)}
        </span>
        <span className="tool-card__name">{humanizeToolName(item.toolName)}</span>
        {runtimeHint ? <span className="chip chip--ghost">{runtimeHint}</span> : null}
        <span className="tool-card__summary">{item.summary}</span>
        <span className="tool-card__meta">
          {item.status === 'running' ? (
            <span className="tool-card__duration tool-card__duration--live">running</span>
          ) : (
            <span className="tool-card__duration">{formatDuration(item.durationMs)}</span>
          )}
          {hasDetail ? (
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="tool-card__chevron" />
          ) : null}
        </span>
      </button>

      {open ? (
        <div className="tool-card__body">
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
    </article>
  );
}
