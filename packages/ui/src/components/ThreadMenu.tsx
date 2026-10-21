import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TaskState, TaskStatus } from '@celeste/protocol';

import { formatRelativeTime } from '../lib/format';
import { Icon } from './Icon';

export interface ThreadMenuProps {
  sessions: TaskState[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Needs approval',
  awaiting_human: 'Needs you',
  paused: 'Paused',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * The compact thread switcher.
 *
 * A docked panel has no room for the session list, but the reader still needs
 * a way to move between threads. This is that way: one button in the header
 * that opens a keyboard-operable menu of the recent threads.
 */
export function ThreadMenu({ sessions, activeId, onSelect, onNew }: ThreadMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const active = sessions.find((session) => session.id === activeId) ?? null;
  const entries = sessions.slice(0, 12);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const index = entries.findIndex((session) => session.id === activeId);
    setActiveIndex(index >= 0 ? index : 0);
  }, [open, entries, activeId]);

  useEffect(() => {
    if (!open) return;
    const node = itemRefs.current[activeIndex];
    node?.focus();
  }, [open, activeIndex]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (entries.length === 0 ? 0 : (index + 1) % entries.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) =>
        entries.length === 0 ? 0 : (index - 1 + entries.length) % entries.length,
      );
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(0, entries.length - 1));
    }
  };

  return (
    <div className="thread-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="thread-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={active ? `Threads. Current: ${active.title}` : 'Open threads'}
        title={active ? active.title : 'Threads'}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="list" size={14} />
        <Icon name="chevron-down" size={13} className="thread-menu__chevron" />
      </button>

      {open ? (
        <div className="thread-menu__panel" role="menu" aria-label="Threads">
          <button
            type="button"
            role="menuitem"
            className="thread-menu__item thread-menu__item--new"
            onClick={() => {
              setOpen(false);
              onNew();
            }}
          >
            <Icon name="plus" size={13} />
            <span>New thread</span>
          </button>

          {entries.length > 0 ? <div className="thread-menu__sep" /> : null}

          {entries.map((session, index) => (
            <button
              type="button"
              role="menuitem"
              key={session.id}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              className={`thread-menu__item${session.id === activeId ? ' thread-menu__item--active' : ''}`}
              onClick={() => {
                setOpen(false);
                onSelect(session.id);
              }}
            >
              <span className="thread-menu__title">{session.title}</span>
              <span className="thread-menu__meta">
                <span className={`pill pill--${session.status}`}>{STATUS_LABEL[session.status]}</span>
                <span className="thread-menu__time">{formatRelativeTime(session.updatedAt)}</span>
              </span>
            </button>
          ))}

          {entries.length === 0 ? (
            <p className="thread-menu__empty">No threads yet.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
