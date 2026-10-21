import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { buildCitations, collectSources } from '../lib/citations';
import type { CitationRef } from '../lib/citations';
import { formatClockTime } from '../lib/format';
import { Markdown } from '../lib/markdown';
import { useTypewriter } from '../lib/typewriter';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { SourcesRow } from './SourcesRow';
import { Suggestions } from './Suggestions';
import { CelesteGlyph } from './Wordmark';
import type { CanvasKind, CanvasState, Source } from '@celeste/protocol';

import type { TimelineItem } from '../state/timeline';
import { ApprovalCard } from './ApprovalCard';
import { ArtifactCard } from './ArtifactCard';
import { PlanView } from './PlanView';
import { ToolCard } from './ToolCard';

/**
 * The starters offered on the empty thread.
 *
 * They are the things an agent that drives a browser is actually good at, and
 * each one fills the composer instead of firing immediately - an agent that
 * clicks things deserves a second look before it starts.
 */
export const STARTERS = [
  'Summarise this page',
  'Compare pricing across these tabs',
  'Fill this form',
  'Collect the links on this page',
  'What did I miss on this page?',
  'Find the cheapest flight to Lisbon',
];

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
  /** Puts a suggested question in the composer instead of running it. */
  onFill?: (question: string) => void;
  /** Opens the task canvas over the thread. */
  onOpenCanvas?: (canvas: CanvasState) => void;
  /** Opens the live browser viewport pane. */
  onOpenBrowser?: () => void;
}

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

/**
 * One assistant answer.
 *
 * The newest answer is revealed character by character so the thread reads as
 * a live conversation; older ones are shown whole.
 */
function AssistantAnswer({
  text,
  reveal,
  citations,
}: {
  text: string;
  reveal: boolean;
  citations?: Map<number, CitationRef>;
}) {
  const shown = useTypewriter(text, reveal);
  return (
    <Markdown
      className="bubble__text bubble__text--prose"
      content={shown}
      citations={citations}
      lead={<CelesteGlyph size={16} className="prose-lead" />}
    />
  );
}

/** Finds the scrollable ancestor of a node. */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  let current: HTMLElement | null = node ? node.parentElement : null;
  while (current) {
    const overflow = getComputedStyle(current).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * The event timeline.
 *
 * Renders the folded `DaemonEvent` stream as a Perplexity-style thread: the
 * reader's own words on the right in a soft bubble, the agent's answers in
 * full-width prose with a small teal glyph, and every tool call folded into
 * a quiet pill.
 */
export function Timeline({
  items,
  sessionId,
  dismissedHumans,
  onDismissHuman,
  onRespondApproval,
  busy,
  taskSources,
  onAsk,
  onFill,
  onOpenCanvas,
  onOpenBrowser,
}: TimelineProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const countRef = useRef(items.length);
  const streamRef = useRef(0);
  const followingRef = useRef(true);
  const lastTopRef = useRef(0);
  const programmaticRef = useRef(false);
  const [showJump, setShowJump] = useState(false);

  // While the answer streams, the item count does not change but its text
  // does. Follow it - unless the reader has scrolled back up to read
  // something, in which case the view stays where they put it.
  const lastItem = items[items.length - 1];
  const streamLength = lastItem?.kind === 'streaming' ? lastItem.text.length : 0;

  const scrollToBottom = useCallback((smooth: boolean) => {
    const node = bottomRef.current;
    if (!node) return;
    const scroller = scrollParent(node);
    programmaticRef.current = true;
    if (smooth) {
      node.scrollIntoView({
        behavior:
          typeof window !== 'undefined' &&
          window.matchMedia &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
        block: 'end',
      });
    } else if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
    window.setTimeout(() => {
      programmaticRef.current = false;
    }, 420);
  }, []);

  useEffect(() => {
    const added = items.length !== countRef.current;
    const grew = streamLength !== streamRef.current;
    countRef.current = items.length;
    streamRef.current = streamLength;
    if (!added && !grew) return;
    if (!followingRef.current) return;

    const node = bottomRef.current;
    if (!node) return;

    if (!added) {
      const scroller = scrollParent(node);
      if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 240) {
        return;
      }
    }

    scrollToBottom(true);
  }, [items.length, streamLength, scrollToBottom]);

  /* Follow the thread while the reader is at the bottom. */
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const scroller = scrollParent(node);
    if (!scroller) return;

    lastTopRef.current = scroller.scrollTop;

    const onScroll = () => {
      if (programmaticRef.current) {
        lastTopRef.current = scroller.scrollTop;
        return;
      }
      const top = scroller.scrollTop;
      const delta = top - lastTopRef.current;
      lastTopRef.current = top;

      // Scrolling up means the reader wants to read something: stop following.
      if (delta < -4) {
        followingRef.current = false;
        setShowJump(true);
        return;
      }
      if (delta > 4) {
        const distance = scroller.scrollHeight - top - scroller.clientHeight;
        const atBottom = distance <= 56;
        followingRef.current = atBottom;
        setShowJump(!atBottom);
      }
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  /* Content that grows (a revealed answer, an expanding card) keeps the view
     pinned to the bottom as long as the reader is already there. */
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!followingRef.current) return;
      const scroller = scrollParent(node);
      if (!scroller) return;
      scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /* Every source the task has gathered, numbered once for the whole thread.
     Sources from the live event stream win; the task's own list fills in the
     ones from before the panel was opened. */
  const sourceIndex = useMemo(() => {
    const map = collectSources(items);
    for (const source of taskSources ?? []) {
      if (!map.has(source.n)) map.set(source.n, source);
    }
    return map;
  }, [items, taskSources]);

  /* The newest answer is the one that gets the typewriter treatment. */
  const lastAnswerId = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (!item) continue;
      if (item.kind === 'streaming') return null;
      if (item.kind === 'message' && item.role === 'assistant' && item.text.trim()) return item.id;
    }
    return null;
  }, [items]);

  return (
    <div
      className={`timeline${items.length === 0 ? ' timeline--empty' : ''}`}
      ref={rootRef}
      aria-live="polite"
      aria-label="Conversation"
    >
      {items.length === 0 ? (
        <EmptyState
          suggestions={STARTERS}
          onSubmit={(query) => onAsk?.(query)}
          onFill={(query) => onFill?.(query)}
        />
      ) : null}
      {items.map((item) => {
        switch (item.kind) {
          case 'message': {
            if (item.role === 'tool') return null;
            const isUser = item.role === 'user';
            // An assistant turn that only requested tools has no prose of its
            // own - the tool card says everything. Rendering an empty bubble
            // just adds noise.
            if (!isUser && !item.text.trim()) return null;
            if (isUser) {
              return (
                <div className="query" key={item.id}>
                  <div className="query__bubble">
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
                    {item.text ? <p className="query__text">{item.text}</p> : null}
                    <time className="query__time" dateTime={new Date(item.at).toISOString()}>
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
                  <AssistantAnswer
                    text={item.text}
                    reveal={item.id === lastAnswerId}
                    citations={cites.byNumber}
                  />
                </div>
                <div className="bubble__meta">
                  <span className="bubble__author">
                    Celeste
                    {item.name ? <span className="badge badge--model">{item.name}</span> : null}
                  </span>
                  <time className="bubble__time" dateTime={new Date(item.at).toISOString()}>
                    {formatClockTime(item.at)}
                  </time>
                  {item.text.trim() ? <CopyButton text={item.text} /> : null}
                </div>
                {cites.refs.length > 0 ? <SourcesRow refs={cites.refs} /> : null}
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
                    lead={<CelesteGlyph size={16} className="prose-lead" />}
                  />
                  <span className="bubble__caret" aria-hidden="true" />
                </div>
                <div className="bubble__meta">
                  <span className="bubble__author">Celeste</span>
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

      {showJump ? (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            followingRef.current = true;
            setShowJump(false);
            scrollToBottom(true);
          }}
        >
          <Icon name="arrow-up" size={12} />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

export type { ReactNode };
