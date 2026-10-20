import { useEffect, useRef } from 'react';

import { formatClockTime } from '../lib/format';
import { Markdown } from '../lib/markdown';
import type { TimelineItem } from '../state/timeline';
import { ApprovalCard } from './ApprovalCard';
import { ArtifactCard } from './ArtifactCard';
import { Icon } from './Icon';
import { PlanView } from './PlanView';
import { ToolCard } from './ToolCard';

export interface TimelineProps {
  items: TimelineItem[];
  sessionId: string | null;
  dismissedHumans: Record<string, true>;
  onDismissHuman: (key: string) => void;
  onRespondApproval: (requestId: string, decision: 'approve' | 'deny') => void;
  busy?: boolean;
}

function reduceMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The event timeline.
 *
 * Renders the folded `DaemonEvent` stream: chat bubbles, collapsible tool
 * cards, the live plan, approval gates, artifact drops and errors.
 */
export function Timeline({
  items,
  sessionId,
  dismissedHumans,
  onDismissHuman,
  onRespondApproval,
  busy,
}: TimelineProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const countRef = useRef(items.length);

  useEffect(() => {
    if (items.length === countRef.current) return;
    countRef.current = items.length;
    const node = bottomRef.current;
    if (!node) return;
    node.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'end' });
  }, [items.length]);

  if (items.length === 0) {
    return (
      <div className="timeline timeline--empty">
        <div className="empty-state">
          <span className="empty-state__icon">
            <Icon name="sparkle" size={22} />
          </span>
          <h2 className="empty-state__title">Nothing here yet</h2>
          <p className="empty-state__text">
            Describe a task below and Celeste will plan it, drive the browser and show you every tool call as it
            happens.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="timeline">
      {items.map((item) => {
        switch (item.kind) {
          case 'message': {
            if (item.role === 'tool') return null;
            const isUser = item.role === 'user';
            // An assistant turn that only requested tools has no prose of its
            // own — the tool card says everything. Rendering an empty bubble
            // just adds noise.
            if (!isUser && !item.text.trim()) return null;
            return (
              <div className={`bubble bubble--${isUser ? 'user' : 'assistant'}`} key={item.id}>
                <div className="bubble__body">
                  {item.text ? (
                    isUser ? (
                      <p className="bubble__text">{item.text}</p>
                    ) : (
                      <Markdown className="bubble__text bubble__text--prose" content={item.text} />
                    )
                  ) : (
                    <p className="bubble__text bubble__text--muted">(empty message)</p>
                  )}
                </div>
                <div className="bubble__meta">
                  {isUser ? (
                    <span className="bubble__author">
                      <Icon name="user" size={11} />
                      You
                    </span>
                  ) : (
                    <span className="bubble__author">
                      <Icon name="bot" size={11} />
                      Celeste
                      {item.name ? <span className="badge badge--model">{item.name}</span> : null}
                    </span>
                  )}
                  <time className="bubble__time" dateTime={new Date(item.at).toISOString()}>
                    {formatClockTime(item.at)}
                  </time>
                </div>
              </div>
            );
          }

          case 'tool':
            return <ToolCard key={item.id} item={item} />;

          case 'plan':
            return <PlanView key={item.id} steps={item.steps} />;

          case 'approval':
            return (
              <ApprovalCard
                key={item.id}
                request={item.request}
                decision={item.decision}
                busy={busy}
                onRespond={onRespondApproval}
              />
            );

          case 'human': {
            const key = `${sessionId ?? 'none'}:${item.id}`;
            if (dismissedHumans[key]) return null;
            return (
              <div className="human-banner" role="status" key={item.id}>
                <span className="human-banner__icon">
                  <Icon name="alert" size={15} />
                </span>
                <div className="human-banner__body">
                  <p className="human-banner__title">Celeste needs you</p>
                  <p className="human-banner__text">{item.reason}</p>
                </div>
                <button
                  type="button"
                  className="button button--tiny button--ghost"
                  onClick={() => onDismissHuman(key)}
                  aria-label="Dismiss human intervention notice"
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            );
          }

          case 'artifact':
            return <ArtifactCard key={item.id} artifact={item.artifact} />;

          case 'error':
            return (
              <div className="error-row" key={item.id} role="alert">
                <Icon name="alert" size={14} />
                <code className="error-row__code">{item.code}</code>
                <span className="error-row__message">{item.message}</span>
              </div>
            );

          case 'status':
            return (
              <div className={`status-row status-row--${item.status}`} key={item.id}>
                <span className="status-row__line" />
                <span className="status-row__label">{item.label}</span>
                <span className="status-row__line" />
              </div>
            );

          default:
            return null;
        }
      })}
      <div ref={bottomRef} />
    </div>
  );
}
