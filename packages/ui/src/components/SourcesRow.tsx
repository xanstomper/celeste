import { useState } from 'react';

import type { CitationRef } from '../lib/citations';
import { initialsFor, hueFor } from '../lib/citations';

export interface SourcesRowProps {
  /** In display order; each carries the number the answer cites it by. */
  refs: CitationRef[];
}

/**
 * The row of sources under an answer.
 *
 * This is the part that makes an answer feel researched rather than
 * asserted: small numbered chips, one per page, each opening the real source.
 * Expanding one shows its title and snippet.
 */
export function SourcesRow({ refs }: SourcesRowProps) {
  const [open, setOpen] = useState<number | null>(null);

  if (refs.length === 0) return null;

  return (
    <section className="sources" aria-label="Sources">
      <div className="sources__label">
        <span className="sources__count">{refs.length}</span>
        {refs.length === 1 ? ' source' : ' sources'}
      </div>

      <div className="sources__list">
        {refs.map((ref) => {
          const source = ref.source;
          const expanded = open === source.n;
          return (
            <div className="source" key={source.n}>
              <div className="source__row">
                <a
                  className="source__chip"
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={source.title}
                >
                  <span
                    className="source__badge"
                    style={{ ['--source-hue' as string]: String(hueFor(source.domain)) }}
                    aria-hidden="true"
                  >
                    {initialsFor(source.domain)}
                  </span>
                  <span className="source__domain">{source.domain}</span>
                  <span className="source__n">{ref.display}</span>
                </a>
                {source.snippet ? (
                  <button
                    type="button"
                    className="source__toggle"
                    aria-expanded={expanded}
                    aria-label={expanded ? 'Hide source detail' : 'Show source detail'}
                    onClick={() => setOpen(expanded ? null : source.n)}
                  >
                    {expanded ? '−' : '+'}
                  </button>
                ) : null}
              </div>

              {expanded ? (
                <div className="source__detail">
                  <a
                    className="source__title"
                    href={source.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {source.title}
                  </a>
                  <p className="source__snippet">{source.snippet}</p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
