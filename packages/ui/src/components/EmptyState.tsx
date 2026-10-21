import { useState } from 'react';
import type { FormEvent } from 'react';

import { Icon } from './Icon';
import { Wordmark } from './Wordmark';

export interface EmptyStateProps {
  /** Runs the query straight away. */
  onSubmit: (query: string) => void;
  /** Puts the query in the composer so the reader can edit it first. */
  onFill: (query: string) => void;
  /** The starter questions offered under the search field. */
  suggestions: string[];
}

/**
 * The landing screen.
 *
 * Perplexity opens on a search field, not a dashboard: one obvious place to
 * type, and a handful of suggestions for the people who do not know what to
 * ask yet. The suggestions fill the composer rather than firing a task
 * straight away - an agent that browses for you deserves a second look before
 * it starts clicking.
 */
export function EmptyState({ onSubmit, onFill, suggestions }: EmptyStateProps) {
  const [value, setValue] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setValue('');
    onSubmit(trimmed);
  };

  return (
    <div className="empty-state">
      <Wordmark size={34} className="empty-state__mark" />

      <h1 className="empty-state__title">Where should we go?</h1>
      <p className="empty-state__text">
        Ask anything, research deep topics, or tell Celeste what to browse and automate.
      </p>

      <form className="empty-state__search" onSubmit={submit}>
        <Icon name="search" size={16} className="empty-state__search-icon" />
        <input
          type="text"
          value={value}
          placeholder="Ask anything…"
          aria-label="Ask anything"
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="submit"
          className={`composer__send-circle${value.trim() ? ' composer__send-circle--active' : ''}`}
          disabled={value.trim().length === 0}
          aria-label="Send"
        >
          <Icon name="arrow-up" size={16} />
        </button>
      </form>

      <div className="empty-state__suggestions">
        {suggestions.map((suggestion) => (
          <button
            type="button"
            key={suggestion}
            className="empty-state__suggestion"
            onClick={() => onFill(suggestion)}
          >
            <span>{suggestion}</span>
            <Icon name="arrow-up" size={12} />
          </button>
        ))}
      </div>
    </div>
  );
}
