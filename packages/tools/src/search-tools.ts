import type { Source, ToolDefinition } from '@celeste/protocol';
import { focusResults } from './focus-sources.js';
import type { ScratchStore, ToolHandler, ToolOutcome } from './types.js';

/**
 * Web research tools.
 *
 * These give the agent the thing that makes an assistant feel like Perplexity
 * rather than a chatbot: it goes and finds sources, reads them, and answers
 * with numbered citations that link back to the real pages.
 *
 * Sources are numbered across the whole task and kept in the task's
 * scratchpad, so `[3]` means the same page in every message of a thread.
 */

const SOURCES_KEY = 'celeste.web.sources';
const SEARCH_COUNT_KEY = 'celeste.web.searches';

/**
 * How many searches one task may run.
 *
 * The prompt asks for one search and at most three pages, and small models
 * routinely ignore it: they rephrase the same question, get the same eight
 * sources, and search again. A hard cap turns that loop into an answer. It is
 * deliberately generous — a comparison or a contested fact can need four.
 */
const MAX_SEARCHES = 5;

function def(
  name: string,
  description: string,
  parameters: ToolDefinition['parameters'],
  requiresApproval = false,
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    runtime: 'browser',
    requiresApproval,
    category: 'web',
  };
}

/** Hostname without `www.`, or the raw string when it is not a URL. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Every source registered for this task, in citation order. */
export function allSources(scratch: ScratchStore): Source[] {
  const stored = scratch.get<Source[]>(SOURCES_KEY);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Registers a page as a citable source.
 *
 * The same URL always gets the same number, so a page the agent reads twice
 * does not sprout two citations.
 */
export function registerSource(
  scratch: ScratchStore,
  input: { url: string; title?: string; snippet?: string },
): Source {
  const sources = allSources(scratch);
  const existing = sources.find((source) => source.url === input.url);
  if (existing) {
    if (input.title && existing.title !== input.title) existing.title = input.title;
    if (input.snippet && !existing.snippet) existing.snippet = input.snippet;
    scratch.set(SOURCES_KEY, sources);
    return existing;
  }

  const source: Source = {
    n: sources.length + 1,
    url: input.url,
    title: input.title?.trim() || domainOf(input.url),
    domain: domainOf(input.url),
    ...(input.snippet ? { snippet: input.snippet.slice(0, 400) } : {}),
  };
  sources.push(source);
  scratch.set(SOURCES_KEY, sources);
  return source;
}

/** Renders sources the way the model should see them. */
function formatForModel(query: string, sources: Source[]): string {
  if (sources.length === 0) {
    return `No results for "${query}". Try a different query, or open a known URL directly.`;
  }
  const lines = sources.map(
    (s) => `[${s.n}] ${s.title}\n    ${s.url}${s.snippet ? `\n    ${s.snippet}` : ''}`,
  );
  return `Results for "${query}":\n\n${lines.join('\n\n')}\n\nCite these as [n] where n is the bracket number above.`;
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

export interface SearchToolOptions {
  /** Default engine. */
  engine?: 'bing' | 'duckduckgo' | 'brave' | 'google';
  /** Injectable feed lookup for the focus modes, so tests stay offline. */
  focusFeed?: typeof focusResults;
}

export function createSearchTools(options: SearchToolOptions = {}): ToolHandler[] {
  // DuckDuckGo answers a plain query box honestly: no personalisation, no
  // "helpful" rewrite of a long query into its first word. Bing is kept as
  // the fallback, which the extension switches to automatically.
  const defaultEngine = options.engine ?? 'duckduckgo';
  const focusFeed = options.focusFeed ?? focusResults;

  const webSearch: ToolHandler = {
    definition: def(
      'web_search',
      'Search the public web and get numbered sources back. Use this FIRST for any question about the current world, products, prices, news, people, or anything you do not already know. Each result is numbered; cite the ones you use inline as [1], [2] and so on.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query, phrased like a person would type it.' },
          limit: {
            type: 'integer',
            description: 'How many results to return (1-15). Default 8.',
            default: 8,
          },
        },
        required: ['query'],
      },
    ),
    async execute(args, ctx): Promise<ToolOutcome> {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
      if (!query) {
        return {
          ok: false,
          summary: 'A search query is required.',
          error: { code: 'INVALID_ARGS', message: 'A search query is required.', retryable: false },
        } satisfies ToolOutcome;
      }

      if (!ctx.browser?.isConnected()) {
        return {
          ok: false,
          summary: 'The browser is not connected.',
          error: {
            code: 'NETWORK_ERROR',
            message:
              'The Celeste browser extension is not connected, so the web cannot be searched. Ask the user to open the browser with `celeste browse`.',
            retryable: true,
          },
        } satisfies ToolOutcome;
      }

      // Research has to end. Without a cap the agent keeps rephrasing the
      // same query and never writes the answer.
      const searches = ctx.scratch.get<number>(SEARCH_COUNT_KEY) ?? 0;
      if (searches >= MAX_SEARCHES) {
        const known = allSources(ctx.scratch);
        return {
          ok: true,
          summary: `Search budget reached (${MAX_SEARCHES})`,
          data: { budgetExhausted: true, results: known },
          text:
            `You have already searched ${MAX_SEARCHES} times. Do not search again. ` +
            `Answer now using the ${known.length} sources you have` +
            (known.length > 0 ? ` (numbered [1] to [${known.length}])` : '') +
            '. If they do not answer the question, say plainly what is missing.',
        } satisfies ToolOutcome;
      }

      const limit = Math.min(Math.max(Number(args['limit'] ?? 8) || 8, 1), 15);
      // The engine is ours to choose: the extension falls back automatically
      // when one returns nothing, and a model that picks "google scholar"
      // only burns a step on a validation error.
      const engine = defaultEngine;

      try {
        const response = await ctx.browser.send<{
          engine: string;
          query: string;
          url: string;
          results: Array<{ rank: number; title: string; url: string; domain: string; snippet: string }>;
        }>('search', { query, limit, engine }, { timeoutMs: 45_000 });

        // Focus modes put their own feed on top of the open-web results:
        // papers for Academic, dated headlines for News. Best-effort, so a
        // feed that is down costs nothing but the extra sources.
        const focus = ctx.store.get(ctx.taskId)?.focus;
        const extra = await focusFeed(focus, query, Math.min(limit, 4));

        const seen = new Set<string>();
        const merged = [...extra, ...(response.results ?? [])]
          .filter((result) => {
            if (seen.has(result.url)) return false;
            seen.add(result.url);
            return true;
          })
          .slice(0, limit);

        ctx.scratch.set(SEARCH_COUNT_KEY, searches + 1);

        const sources = merged.map((result) =>
          registerSource(ctx.scratch, {
            url: result.url,
            title: result.title,
            snippet: result.snippet,
          }),
        );

        const extraUrls = new Set(extra.map((result) => result.url));
        const extraCount = sources.filter((source) => extraUrls.has(source.url)).length;
        const extraLabel =
          extraCount === 0
            ? ''
            : focus === 'academic'
              ? ` (${extraCount} papers)`
              : ` (${extraCount} headlines)`;

        return {
          ok: true,
          summary:
            sources.length === 0
              ? `No results for "${query}"`
              : `Found ${sources.length} sources${extraLabel} for "${query}"`,
          data: { engine: response.engine, query, focus: focus ?? 'web', results: sources },
          text: formatForModel(query, sources),
          sources,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          summary: `Search failed: ${message}`,
          error: { code: 'INTERNAL', message: `Search failed: ${message}`, retryable: true },
        };
      }
    },
  };

  const webOpen: ToolHandler = {
    definition: def(
      'web_open',
      'Open a URL in a background tab, read the page text, and register it as a numbered source. Cheaper and tidier than navigating the user\'s tab when you only need to read something.',
      {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The absolute URL to read.' },
          maxChars: {
            type: 'integer',
            description: 'Maximum characters of page text to return. Default 12000.',
            default: 12000,
          },
        },
        required: ['url'],
      },
    ),
    async execute(args, ctx): Promise<ToolOutcome> {
      const url = typeof args['url'] === 'string' ? args['url'].trim() : '';
      if (!url || !/^https?:\/\//i.test(url)) {
        return {
          ok: false,
          summary: 'A valid http(s) URL is required.',
          error: {
            code: 'INVALID_ARGS',
            message: 'Only absolute http(s) URLs can be opened.',
            retryable: false,
          },
        };
      }
      if (!ctx.browser?.isConnected()) {
        return {
          ok: false,
          summary: 'The browser is not connected.',
          error: {
            code: 'NETWORK_ERROR',
            message: 'The Celeste browser extension is not connected.',
            retryable: true,
          },
        };
      }

      const maxChars = Math.min(Math.max(Number(args['maxChars'] ?? 12_000) || 12_000, 500), 60_000);
      let tabId: number | undefined;

      try {
        const created = await ctx.browser.send<{ tab: { id: number } }>('tabs', {
          action: 'create',
          url: 'about:blank',
          active: false,
        });
        tabId = created.tab?.id;
        if (typeof tabId !== 'number') throw new Error('The browser did not return a tab id.');

        // Navigating through the browser's own navigate verb (rather than
        // creating the tab at the URL) means the extension waits for the
        // document to finish loading before it is asked to read it.
        await ctx.browser.send(
          'navigate',
          { url, waitUntil: 'load' },
          { tabId, timeoutMs: 45_000 },
        );

        // A slow client-rendered page can still be settling, so retry the
        // read a couple of times before giving up.
        let text: { text?: string } | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            text = await ctx.browser.send<{ text: string }>(
              'getText',
              {},
              { tabId, timeoutMs: 30_000 },
            );
            if ((text?.text ?? '').length > 0) break;
          } catch (err) {
            if (attempt === 2) throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 900));
        }

        const meta = await ctx.browser.send<{ title?: string; url?: string }>(
          'evaluate',
          { expression: '({ title: document.title || "", url: location.href })' },
          { tabId },
        );

        const finalUrl = typeof meta?.url === 'string' && meta.url ? meta.url : url;
        const title = typeof meta?.title === 'string' && meta.title ? meta.title : domainOf(finalUrl);
        const body = (text?.text ?? '').slice(0, maxChars);

        const source = registerSource(ctx.scratch, {
          url: finalUrl,
          title,
          snippet: body.slice(0, 300),
        });

        return {
          ok: true,
          summary: `Read ${source.domain} (${body.length.toLocaleString()} chars) — source [${source.n}]`,
          data: { url: finalUrl, title, source, text: body },
          text: `[${source.n}] ${title}\n${finalUrl}\n\n${body}`,
          sources: [source],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          summary: `Could not read ${url}: ${message}`,
          error: { code: 'INTERNAL', message: `Could not read ${url}: ${message}`, retryable: true },
        };
      } finally {
        if (typeof tabId === 'number') {
          await ctx.browser.send('tabs', { action: 'close', tabId }).catch(() => undefined);
        }
      }
    },
  };

  const webSources: ToolHandler = {
    definition: def(
      'web_sources',
      'List every source collected so far in this task, with the number to cite it by. Use this before writing a final answer so the citations are right.',
      { type: 'object', properties: {} },
    ),
    async execute(_args, ctx): Promise<ToolOutcome> {
      const sources = allSources(ctx.scratch);
      return {
        ok: true,
        summary: sources.length === 0 ? 'No sources collected yet' : `${sources.length} sources collected`,
        data: { sources },
        text: formatForModel('collected sources', sources),
        sources,
      };
    },
  };

  return [webSearch, webOpen, webSources];
}
