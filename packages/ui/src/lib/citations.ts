import type { Source } from '@celeste/protocol';
import type { TimelineItem } from '../state/timeline';

/**
 * Citation plumbing.
 *
 * Sources are numbered once per task. The agent writes `[3]`, and the number
 * resolves to the same page everywhere in the conversation.
 */

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

/** Resolves citation numbers to the sources they point at. */
export function resolveSources(numbers: number[], index: Map<number, Source>): Source[] {
  const out: Source[] = [];
  for (const n of numbers) {
    const source = index.get(n);
    if (source) out.push(source);
  }
  return out;
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
