import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@celeste/protocol';
import { ToolRegistry } from '../src/registry.js';
import { createSearchTools } from '../src/search-tools.js';
import { decodeEntities, parseArxiv, parseNews } from '../src/focus-sources.js';
import type { ToolContext } from '../src/types.js';

function call(args: Record<string, unknown>): ToolCall {
  return { id: 'call_search', name: 'web_search', arguments: args };
}

function makeContext(focus?: 'web' | 'academic' | 'news'): ToolContext {
  const scratch = new Map<string, unknown>();
  return {
    taskId: 'task_test',
    signal: new AbortController().signal,
    bus: { publish: () => {} },
    store: {
      get: (id) =>
        id === 'task_test'
          ? ({
              id: 'task_test',
              title: 'test',
              status: 'running',
              plan: [],
              messages: [],
              scratch: {},
              artifacts: [],
              createdAt: 0,
              updatedAt: 0,
              ...(focus ? { focus } : {}),
            } as never)
          : undefined,
    },
    outputDir: '/tmp',
    approval: { request: async () => true },
    scratch: {
      get: <T = unknown>(key: string) => scratch.get(key) as T | undefined,
      set: (key, value) => void scratch.set(key, value),
      delete: (key) => void scratch.delete(key),
      keys: () => [...scratch.keys()],
    },
    emitArtifact: () => {},
    browser: {
      isConnected: () => true,
      send: async () => ({
        engine: 'duckduckgo',
        query: 'hubble',
        url: 'https://duckduckgo.com/?q=hubble',
        results: [
          {
            rank: 1,
            title: 'Hubble overview',
            url: 'https://science.nasa.gov/hubble',
            domain: 'science.nasa.gov',
            snippet: 'A space telescope.',
          },
          {
            rank: 2,
            title: 'Hubble - Wikipedia',
            url: 'https://en.wikipedia.org/wiki/Hubble',
            domain: 'en.wikipedia.org',
            snippet: 'An overview.',
          },
        ],
      }),
    },
  };
}

describe('focus feeds', () => {
  it('decodes the entities feeds actually emit', () => {
    expect(decodeEntities('Webb &amp; Hubble &#8212; NASA &#x27;s')).toBe(
      "Webb & Hubble \u2014 NASA 's",
    );
  });

  it('reads arXiv entries into url, title and a byline snippet', () => {
    const xml = `<feed><entry>
      <id>http://arxiv.org/abs/2401.00001v1</id>
      <title>A &amp; B: a study of   galaxies</title>
      <summary>We measure things.</summary>
      <published>2024-01-02T00:00:00Z</published>
      <author><name>Ada Lovelace</name></author>
      <author><name>Alan Turing</name></author>
    </entry></feed>`;

    const [paper] = parseArxiv(xml);
    expect(paper?.url).toBe('http://arxiv.org/abs/2401.00001v1');
    expect(paper?.title).toBe('A & B: a study of galaxies');
    expect(paper?.snippet).toContain('Ada Lovelace, Alan Turing');
    expect(paper?.snippet).toContain('2024-01-02');
  });

  it('reads Google News items with a date and publisher', () => {
    const xml = `<rss><channel><item>
      <title>Hubble spots something</title>
      <link>https://news.google.com/rss/articles/abc</link>
      <pubDate>Tue, 20 Oct 2026 08:00:00 GMT</pubDate>
      <source url="https://example.com">Example News</source>
    </item></channel></rss>`;

    const [headline] = parseNews(xml);
    expect(headline?.url).toBe('https://news.google.com/rss/articles/abc');
    expect(headline?.snippet).toBe('2026-10-20 · Example News');
  });
});

describe('web_search with a focus', () => {
  function registry(feedResults: Array<{ url: string; title: string; snippet?: string }>) {
    const registry = new ToolRegistry();
    registry.registerAll(
      createSearchTools({
        focusFeed: async (focus, _query, limit) =>
          focus === 'academic' || focus === 'news' ? feedResults.slice(0, limit) : [],
      }),
    );
    return registry;
  }

  it('puts papers first and says how many it added', async () => {
    const result = await registry([
      { url: 'https://arxiv.org/abs/2401.1', title: 'A paper', snippet: 'Abstract.' },
    ]).execute(call({ query: 'hubble' }), makeContext('academic'));

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('1 papers');
    expect(result.sources?.[0]?.url).toBe('https://arxiv.org/abs/2401.1');
    expect(result.sources?.[1]?.url).toBe('https://science.nasa.gov/hubble');
    expect(result.text).toContain('[1] A paper');
  });

  it('does not duplicate a page that both feeds returned', async () => {
    const result = await registry([
      { url: 'https://science.nasa.gov/hubble', title: 'Hubble overview (paper)' },
    ]).execute(call({ query: 'hubble' }), makeContext('academic'));

    const urls = (result.sources ?? []).map((source) => source.url);
    expect(urls.filter((url) => url === 'https://science.nasa.gov/hubble')).toHaveLength(1);
  });

  it('stops after five searches and tells the model to answer', async () => {
    let browserCalls = 0;
    const registry = new ToolRegistry();
    registry.registerAll(createSearchTools({ focusFeed: async () => [] }));

    const ctx = makeContext('web');
    ctx.browser = {
      isConnected: () => true,
      send: async () => {
        browserCalls += 1;
        return { engine: 'duckduckgo', query: 'q', url: 'https://duckduckgo.com', results: [] };
      },
    };

    for (let index = 0; index < 5; index++) {
      await registry.execute(call({ query: `query ${index}` }), ctx);
    }

    const sixth = await registry.execute(call({ query: 'one more' }), ctx);
    expect(sixth.ok).toBe(true);
    expect(sixth.summary).toContain('budget');
    expect(sixth.text).toContain('Do not search again');
    expect(browserCalls).toBe(5);
  });

  it('lets a research task search twelve times', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(createSearchTools({ focusFeed: async () => [] }));
    const ctx = makeContext('web');
    // A research task: the depth is on the task, not on the call.
    ctx.store = {
      get: (id) =>
        id === 'task_test'
          ? ({
              id: 'task_test',
              title: 'test',
              status: 'running',
              depth: 'research',
              plan: [],
              messages: [],
              scratch: {},
              artifacts: [],
              createdAt: 0,
              updatedAt: 0,
            } as never)
          : undefined,
    };

    let calls = 0;
    ctx.browser = {
      isConnected: () => true,
      send: async () => {
        calls += 1;
        return { engine: 'duckduckgo', query: 'q', url: 'https://duckduckgo.com', results: [] };
      },
    };

    for (let index = 0; index < 12; index++) {
      await registry.execute(call({ query: `query ${index}` }), ctx);
    }
    const thirteenth = await registry.execute(call({ query: 'one more' }), ctx);

    expect(thirteenth.summary).toContain('budget');
    expect(calls).toBe(12);
  });

  it('leaves a plain web search untouched', async () => {
    const result = await registry([{ url: 'https://arxiv.org/abs/2401.1', title: 'A paper' }]).execute(
      call({ query: 'hubble' }),
      makeContext('web'),
    );

    expect(result.sources?.map((source) => source.url)).not.toContain('https://arxiv.org/abs/2401.1');
    expect(result.summary).not.toContain('papers');
  });
});
