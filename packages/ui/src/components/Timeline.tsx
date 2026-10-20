import { useCallback, useEffect, useRef, useState } from 'react';

import { buildCitations, collectSources } from '../lib/citations';
import { formatClockTime } from '../lib/format';
import { Markdown } from '../lib/markdown';
import { SourcesRow } from './SourcesRow';
import { Suggestions } from './Suggestions';
import type { CanvasKind, CanvasState, Source } from '@celeste/protocol';

const STARTERS = [
  'Compare the leading AI browsers',
  'Find the best espresso machine under $500',
  'How does CRISPR work?',
  'Summarise today in tech news',
];
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
  /** Sources the task collected, for threads restored from the daemon. */
  taskSources?: Source[];
  /** Starts a new turn from a suggested question. */
  onAsk?: (question: string) => void;
  /** Opens the task canvas over the thread. */
  onOpenCanvas?: (canvas: CanvasState) => void;
  /** Opens the live browser viewport pane. */
  onOpenBrowser?: () => void;
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
/**
 * Copies an answer, and says so for a moment.
 *
 * Perplexity puts this under every answer because the first thing people do
 * with research is paste it somewhere else.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => undefined);
  }, [text]);

  return (
    <button
      type="button"
      className="bubble__copy"
      onClick={copy}
      title="Copy answer"
      aria-label="Copy answer"
    >
      <Icon name={copied ? 'check' : 'copy'} size={11} />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function Timeline({
  items,
  sessionId,
  dismissedHumans,
  onDismissHuman,
  onRespondApproval,
  busy,
  taskSources,
  onAsk,
  onOpenCanvas,
  onOpenBrowser,
}: TimelineProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const countRef = useRef(items.length);
  const streamRef = useRef(0);

  // While the answer streams, the item count does not change but its text
  // does. Follow it — unless the reader has scrolled back up to read
  // something, in which case the view stays where they put it.
  const lastItem = items[items.length - 1];
  const streamLength = lastItem?.kind === 'streaming' ? lastItem.text.length : 0;

  useEffect(() => {
    const added = items.length !== countRef.current;
    const grew = streamLength !== streamRef.current;
    countRef.current = items.length;
    streamRef.current = streamLength;
    if (!added && !grew) return;

    const node = bottomRef.current;
    if (!node) return;

    if (!added) {
      let scroller: HTMLElement | null = node.parentElement;
      while (scroller) {
        const overflow = getComputedStyle(scroller).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') break;
        scroller = scroller.parentElement;
      }
      if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 240) {
        return;
      }
    }

    node.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'end' });
  }, [items.length, streamLength]);

  if (items.length === 0) {
    return (
      <div className="timeline timeline--empty">
        <div className="empty-state">
          <span className="empty-state__icon">
            <Icon name="sparkle" size={24} />
          </span>
          <h2 className="empty-state__title">What do you want to know?</h2>
          <p className="empty-state__text">
            Ask anything, or tell Celeste what to do in your browser. It plans, searches the live web and shows
            every step.
          </p>
          <div className="empty-state__starters">
            {STARTERS.map((starter) => (
              <button
                type="button"
                key={starter}
                className="empty-state__starter"
                onClick={() => onAsk?.(starter)}
                disabled={!onAsk}
              >
                <span>{starter}</span>
                <Icon name="chevron-right" size={13} />
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Every source the task has gathered, numbered once for the whole thread.
  // Sources from the live event stream win; the task's own list fills in the
  // ones from before the panel was opened.
  const sourceIndex = collectSources(items);
  for (const source of taskSources ?? []) {
    if (!sourceIndex.has(source.n)) sourceIndex.set(source.n, source);
  }

  // Only the newest answer carries the source row, so a long thread does not
  // repeat the same list under every message.
  const lastAnswerId = [...items]
    .reverse()
    .find(
      (item) => item.kind === 'message' && item.role === 'assistant' && item.text.trim().length > 0,
    )?.id;

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
            if (isUser) {
              return (
                <div className="query" key={item.id}>
                  {item.images && item.images.length > 0 ? (
                    <div className="bubble__images">
                      {item.images.map((image, index) => (
                        <img
                          key={`${item.id}-image-${index}`}
                          className="bubble__image"
                          src={`data:${image.mimeType};base64,${image.data}`}
                          alt={`Attachment ${index + 1}`}
                        />
                      ))}
                    </div>
                  ) : null}
                  {item.text ? <h2 className="query__text">{item.text}</h2> : null}
                  <div className="query__meta">
                    <Icon name="user" size={11} />
                    <span>You</span>
                    <time className="bubble__time" dateTime={new Date(item.at).toISOString()}>
                      {formatClockTime(item.at)}
                    </time>
                  </div>
                </div>
              );
            }

            const cites = buildCitations(item.text, sourceIndex);
            return (
              <div className="bubble bubble--assistant" key={item.id}>
                <div className="bubble__body">
                  <Markdown
                    className="bubble__text bubble__text--prose"
                    content={item.text}
                    citations={cites.byNumber}
                  />
                </div>
                <div className="bubble__meta">
                  <span className="bubble__author">
                    <Icon name="bot" size={11} />
                    Celeste
                    {item.name ? <span className="badge badge--model">{item.name}</span> : null}
                  </span>
                  <time className="bubble__time" dateTime={new Date(item.at).toISOString()}>
                    {formatClockTime(item.at)}
                  </time>
                  {item.text.trim() ? <CopyButton text={item.text} /> : null}
                </div>
                {cites.refs.length > 0 && item.id === lastAnswerId ? (
                  <SourcesRow refs={cites.refs} />
                ) : null}
              </div>
            );
          }

          case 'streaming': {
            if (!item.text.trim()) return null;
            const cites = buildCitations(item.text, sourceIndex);
            return (
              <div className="bubble bubble--assistant bubble--streaming" key={item.id}>
                <div className="bubble__body">
                  <Markdown
                    className="bubble__text bubble__text--prose"
                    content={item.text}
                    citations={cites.byNumber}
                  />
                  <span className="bubble__caret" aria-hidden="true" />
                </div>
                <div className="bubble__meta">
                  <span className="bubble__author">
                    <Icon name="bot" size={11} />
                    Celeste
                  </span>
                  <span className="bubble__writing">writing…</span>
                </div>
              </div>
            );
          }

          case 'canvas': {
            const icon: Record<CanvasKind, 'file' | 'sparkle' | 'image' | 'folder'> = {
              document: 'file',
              visual: 'sparkle',
              image: 'image',
              project: 'folder',
            };
            return (
              <button
                type="button"
                className="canvas-card"
                key={item.id}
                onClick={() => onOpenCanvas?.(item.canvas)}
              >
                <span className="canvas-card__icon">
                  <Icon name={icon[item.canvas.kind]} size={17} />
                </span>
                <span className="canvas-card__text">
                  <span className="canvas-card__title">{item.canvas.title}</span>
                  <span className="canvas-card__meta">
                    {item.canvas.kind} canvas · click to open
                  </span>
                </span>
                <Icon name="chevron-right" size={15} />
              </button>
            );
          }

          case 'tool':
            return <ToolCard key={item.id} item={item} onOpenBrowser={onOpenBrowser} />;

          case 'browser': {
            return (
              <div
                className="browser-action-card"
                key={item.id}
                onClick={onOpenBrowser}
                role="button"
                tabIndex={0}
                title="Open Live Browser Viewport"
              >
                <div className="browser-action-card__left">
                  <span className={`browser-action-card__badge action-badge--${item.action.action}`}>
                    <Icon name="globe" size={12} />
                    {item.action.action.toUpperCase()}
                  </span>
                  <span className="browser-action-card__title">
                    {item.action.action === 'click' && item.action.point
                      ? `Clicked at (${Math.round(item.action.point.x)}, ${Math.round(
                          item.action.point.y,
                        )})`
                      : item.action.url || item.action.title || 'Browser action'}
                  </span>
                </div>
                <span className="browser-action-card__view">
                  <Icon name="eye" size={12} />
                  Live Browser
                </span>
              </div>
            );
          }

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

          case 'suggestions':
            if (!onAsk) return null;
            return (
              <Suggestions key={item.id} questions={item.questions} onAsk={onAsk} />
            );

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
