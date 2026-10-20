/**
 * Extra sources for the focus modes.
 *
 * The open-web search runs through the user's real browser, because search
 * engines block plain HTTP clients. Papers and headlines are different:
 * arXiv and Google News both publish machine-readable feeds, so asking them
 * directly is faster and returns cleaner metadata (authors, publication
 * dates) than scraping a search page ever could.
 *
 * Everything here is best-effort. A feed that is slow, rate-limited, or down
 * must never fail a search — the open-web results still arrive.
 */

import type { SearchFocus } from '@celeste/protocol';

export interface FocusResult {
  url: string;
  title: string;
  snippet?: string;
}

const FEED_TIMEOUT_MS = 8_000;

/** Minimal XML entity decoding — feeds escape quotes, ampersands and tags. */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Flattens markup inside a feed field into one line of text. */
function stripTags(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** The text of the first `<name>…</name>` inside a fragment. */
function tag(fragment: string, name: string): string {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(fragment);
  return match ? stripTags(match[1] ?? '') : '';
}

/** arXiv returns Atom: one `<entry>` per paper. */
export function parseArxiv(xml: string): FocusResult[] {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => match[1] ?? '');

  return entries.flatMap((entry) => {
    const url = tag(entry, 'id');
    const title = tag(entry, 'title');
    if (!url || !title) return [];

    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)]
      .map((match) => stripTags(match[1] ?? ''))
      .filter(Boolean);
    const byline =
      authors.length === 0
        ? ''
        : authors.length > 3
          ? `${authors.slice(0, 3).join(', ')} et al.`
          : authors.join(', ');

    const published = tag(entry, 'published').slice(0, 10);
    const summary = tag(entry, 'summary');
    const snippet = [byline, published, summary].filter(Boolean).join(' · ').slice(0, 380);

    return [{ url, title, ...(snippet ? { snippet } : {}) }];
  });
}

/** Google News returns RSS: one `<item>` per headline. */
export function parseNews(xml: string): FocusResult[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1] ?? '');

  return items.flatMap((item) => {
    const url = tag(item, 'link');
    const title = tag(item, 'title');
    if (!url || !title) return [];

    const published = tag(item, 'pubDate');
    const when = published ? new Date(published) : null;
    const date =
      when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 10) : published;
    const source = tag(item, 'source');
    const snippet = [date, source].filter(Boolean).join(' · ');

    return [{ url, title, ...(snippet ? { snippet } : {}) }];
  });
}

async function fetchText(url: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Celeste/0.1 (open-source browser agent)' },
    });
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    // A feed that cannot be reached is not an error worth surfacing: the
    // open-web half of the search is unaffected.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Papers or headlines for a query, most relevant first.
 *
 * Returns an empty list for `web`, and for any feed that fails.
 */
export async function focusResults(
  focus: SearchFocus | undefined,
  query: string,
  limit = 4,
): Promise<FocusResult[]> {
  if (focus !== 'academic' && focus !== 'news') return [];

  const capped = Math.min(Math.max(limit, 1), 8);

  if (focus === 'academic') {
    const xml = await fetchText(
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}` +
        `&max_results=${capped}&sortBy=relevance`,
    );
    return xml ? parseArxiv(xml).slice(0, capped) : [];
  }

  const xml = await fetchText(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
  );
  return xml ? parseNews(xml).slice(0, capped) : [];
}
