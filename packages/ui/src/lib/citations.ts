import type { Source } from '@celeste/protocol';
import type { TimelineItem } from '../state/timeline';

/**
 * Citation plumbing.
 *
 * Sources are numbered once per task, so `[3]` means the same page for the
 * whole thread. An answer is then *displayed* with its own numbering, in
 * order of first appearance — a reader should see "1", not "17", when the
 * answer only used one page.
 */

/** A citation as it appears in one answer. */
export interface CitationRef {
  /** The number the reader sees: 1, 2, 3, in order of appearance. */
  display: number;
  source: Source;
}

/** Every source the task has collected so far, keyed by citation number. */
export function collectSources(items: TimelineItem[]): Map<number, Source> {
  const map = new Map<number, Source>();
  for (const item of items) {
    if (item.kind !== 'tool' || !item.sources) continue;
    for (const source of item.sources) {
      if (!map.has(source.n)) map.set(source.n, source);
    }
  }
  return map;
}

const CITATION = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;

/** The citation numbers used in a message, in order of first appearance. */
export function citedNumbers(text: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  CITATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION.exec(text)) !== null) {
    for (const part of (match[1] ?? '').split(',')) {
      const n = Number(part.trim());
      if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

export interface Citations {
  /** In display order, for the source row. */
  refs: CitationRef[];
  /** Keyed by the number written in the prose, for the inline pills. */
  byNumber: Map<number, CitationRef>;
}

/**
 * Resolves the numbers in an answer to sources and renumbers them for display.
 *
 * Numbers with no matching source are dropped rather than rendered as dead
 * links: a citation the reader cannot follow is worse than none.
 */
export function buildCitations(text: string, index: Map<number, Source>): Citations {
  const refs: CitationRef[] = [];
  const byNumber = new Map<number, CitationRef>();

  for (const n of citedNumbers(text)) {
    const source = index.get(n);
    if (!source) continue;
    const ref: CitationRef = { display: refs.length + 1, source };
    refs.push(ref);
    byNumber.set(n, ref);
  }

  return { refs, byNumber };
}

/** A stable, pleasant hue for a domain, so its badge is recognisable. */
export function hueFor(domain: string): number {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) % 360;
  }
  return hash;
}

/** One or two letters that identify a domain at a glance. */
export function initialsFor(domain: string): string {
  const parts = domain
    .replace(/^www\./, '')
    .split('.')
    .filter((part) => part.length > 0 && part !== 'co' && part !== 'com');
  const first = parts[0] ?? domain;
  return first.slice(0, 2).toUpperCase();
}
