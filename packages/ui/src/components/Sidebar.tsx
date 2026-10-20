import { useMemo, useState } from 'react';
import type { TaskState, TaskStatus } from '@celeste/protocol';

import { formatRelativeTime } from '../lib/format';
import { Icon } from './Icon';

export interface SidebarProps {
  sessions: TaskState[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
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
 * The session list.
 */
export function Sidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  collapsed = false,
  onToggleCollapsed,
}: SidebarProps) {
  const [filter, setFilter] = useState('');

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((task) => task.title.toLowerCase().includes(needle));
  }, [sessions, filter]);

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`} aria-label="Sessions">
      <div className="sidebar__top">
        <button type="button" className="button button--primary button--block" onClick={onNew}>
          <Icon name="plus" size={15} />
          New task
        </button>

        <div className="sidebar__search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={filter}
            placeholder="Filter tasks"
            aria-label="Filter tasks"
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </div>

      <nav className="sidebar__list" aria-label="Task list">
        {visible.length === 0 ? (
          <p className="sidebar__empty">
            {sessions.length === 0 ? 'No tasks yet — start one above.' : 'No tasks match that filter.'}
          </p>
        ) : null}

        {visible.map((task) => {
          const isActive = task.id === activeId;
          const artifactCount = task.artifacts.length;
          return (
            <button
              type="button"
              key={task.id}
              className={`session-item${isActive ? ' session-item--active' : ''}`}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => onSelect(task.id)}
              title={task.title}
            >
              <span className="session-item__row">
                <span className="session-item__title">{task.title}</span>
                <span className={`pill pill--${task.status}`}>{STATUS_LABEL[task.status]}</span>
              </span>
              <span className="session-item__row session-item__row--meta">
                <span className="session-item__time">{formatRelativeTime(task.updatedAt)}</span>
                {artifactCount > 0 ? (
                  <span className="session-item__artifacts" title={`${artifactCount} artifacts`}>
                    <Icon name="file" size={11} />
                    {artifactCount}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </nav>

      {onToggleCollapsed ? (
        <button
          type="button"
          className="sidebar__collapse"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={14} />
          <span>{collapsed ? '' : 'Collapse'}</span>
        </button>
      ) : null}
    </aside>
  );
}
