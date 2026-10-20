import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ProviderSummary, TaskState } from '@celeste/protocol';

import { formatRelativeTime } from '../lib/format';
import { fuzzySearch, highlightSegments } from '../lib/fuzzy';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon?: IconName;
  keywords?: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  sessions: TaskState[];
  providers: ProviderSummary[];
  actions: PaletteAction[];
  onSelectSession: (id: string) => void;
  onSelectProvider: (id: string) => void;
  onRunAction: (id: string) => void;
}

interface Result {
  key: string;
  group: 'Actions' | 'Sessions' | 'Providers';
  label: string;
  hint: string;
  icon: IconName;
  indices: number[];
  run: () => void;
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  return (
    <>
      {highlightSegments(text, indices).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="palette__match">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/**
 * The `Cmd/Ctrl+K` command palette.
 *
 * Fuzzy searches actions, sessions and providers in one list.
 */
export function CommandPalette({
  open,
  onClose,
  sessions,
  providers,
  actions,
  onSelectSession,
  onSelectProvider,
  onRunAction,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo<Result[]>(() => {
    const actionHits = fuzzySearch(query, actions, (action) =>
      `${action.label} ${action.keywords ?? ''}`.trim(),
    ).map<Result>((hit) => ({
      key: `action:${hit.item.id}`,
      group: 'Actions',
      label: hit.item.label,
      hint: hit.item.hint ?? '',
      icon: hit.item.icon ?? 'sparkle',
      indices: hit.indices,
      run: () => onRunAction(hit.item.id),
    }));

    const sessionHits = fuzzySearch(query, sessions, (session) => session.title).map<Result>((hit) => ({
      key: `session:${hit.item.id}`,
      group: 'Sessions',
      label: hit.item.title,
      hint: `${hit.item.status} · ${formatRelativeTime(hit.item.updatedAt)}`,
      icon: 'bot',
      indices: hit.indices,
      run: () => onSelectSession(hit.item.id),
    }));

    const providerHits = fuzzySearch(query, providers, (provider) =>
      `${provider.label} ${provider.model} ${provider.kind}`.trim(),
    ).map<Result>((hit) => ({
      key: `provider:${hit.item.id}`,
      group: 'Providers',
      label: hit.item.label,
      hint: `${hit.item.model} · ${hit.item.kind}${hit.item.active ? ' · active' : ''}`,
      icon: 'sparkle',
      indices: hit.indices,
      run: () => onSelectProvider(hit.item.id),
    }));

    return [...actionHits, ...sessionHits, ...providerHits];
  }, [actions, onRunAction, onSelectProvider, onSelectSession, providers, query, sessions]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setActiveIndex((index) => (index >= results.length ? 0 : index));
  }, [results.length]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open) return null;

  const runActive = () => {
    const result = results[activeIndex];
    if (!result) return;
    result.run();
    onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) =>
        results.length === 0 ? 0 : (index - 1 + results.length) % results.length,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runActive();
    }
  };

  let lastGroup: Result['group'] | null = null;

  return (
    <div className="overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette__search">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search tasks, providers and actions…"
            aria-label="Search commands"
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd className="kbd">Esc</kbd>
        </div>

        <div className="palette__results" ref={listRef} role="listbox" aria-label="Results">
          {results.length === 0 ? (
            <p className="palette__empty">Nothing matches “{query}”.</p>
          ) : null}

          {results.map((result, index) => {
            const showHeader = result.group !== lastGroup;
            lastGroup = result.group;
            return (
              <div key={result.key}>
                {showHeader ? <p className="palette__group">{result.group}</p> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-active={index === activeIndex}
                  className={`palette__item${index === activeIndex ? ' palette__item--active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    result.run();
                    onClose();
                  }}
                >
                  <Icon name={result.icon} size={14} />
                  <span className="palette__label">
                    <Highlighted text={result.label} indices={result.indices} />
                  </span>
                  {result.hint ? <span className="palette__hint">{result.hint}</span> : null}
                </button>
              </div>
            );
          })}
        </div>

        <div className="palette__footer">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> navigate
          </span>
          <span>
            <kbd className="kbd">↵</kbd> select
          </span>
          <span>
            <kbd className="kbd">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
