/**
 * A small fuzzy matcher used by the command palette and the provider picker.
 *
 * Subsequence matching with bonuses for consecutive characters and word
 * boundaries - good enough for a few hundred candidates, and zero bytes of
 * dependency.
 */

export interface FuzzyMatch {
  score: number;
  indices: number[];
}

const BOUNDARY = ' -_/.:·>';

export function fuzzyScore(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] };

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let cursor = 0;
  let streak = 0;

  for (let qi = 0; qi < q.length; qi += 1) {
    const needle = q.charAt(qi);
    if (needle === ' ') continue;

    let found = t.indexOf(needle, cursor);
    if (found === -1) {
      // Fall back to a loose scan so "opp" still matches "OpenCode Zen".
      found = t.indexOf(needle);
      if (found === -1) return null;
    }

    if (indices.length > 0 && found === indices[indices.length - 1]! + 1) {
      streak += 1;
      score += 6 + streak * 2;
    } else {
      streak = 0;
      score += 1;
    }

    const previous = found > 0 ? t.charAt(found - 1) : '';
    if (found === 0 || BOUNDARY.includes(previous)) score += 8;

    indices.push(found);
    cursor = found + 1;
  }

  score -= Math.min(target.length, 48) * 0.08;
  return { score, indices };
}

export interface FuzzyHit<T> {
  item: T;
  score: number;
  indices: number[];
}

/**
 * Filters and ranks a list of candidates.
 */
export function fuzzySearch<T>(
  query: string,
  items: readonly T[],
  toText: (item: T) => string,
): FuzzyHit<T>[] {
  const hits: FuzzyHit<T>[] = [];
  for (const item of items) {
    const text = toText(item);
    const match = fuzzyScore(query, text);
    if (!match) continue;
    hits.push({ item, score: match.score, indices: match.indices });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * Splits a string into matched / unmatched segments so the UI can highlight
 * the fuzzy hit without any DOM measuring.
 */
export function highlightSegments(
  text: string,
  indices: readonly number[],
): { text: string; match: boolean }[] {
  if (indices.length === 0) return [{ text, match: false }];
  const set = new Set(indices);
  const segments: { text: string; match: boolean }[] = [];
  let buffer = '';
  let bufferMatch = set.has(0);

  for (let i = 0; i < text.length; i += 1) {
    const match = set.has(i);
    if (match !== bufferMatch) {
      if (buffer) segments.push({ text: buffer, match: bufferMatch });
      buffer = '';
      bufferMatch = match;
    }
    buffer += text.charAt(i);
  }
  if (buffer) segments.push({ text: buffer, match: bufferMatch });
  return segments;
}
