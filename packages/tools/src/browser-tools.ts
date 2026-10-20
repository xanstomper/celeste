import type { ToolCall, ToolDefinition } from '@celeste/protocol';
import type { BrowserClient, ToolContext, ToolHandler } from './types.js';
import { fail, ok } from './types.js';
import { registerSource } from './search-tools.js';

/**
 * Registers a page the agent just read as a citable source.
 *
 * Every page the agent actually reads earns a number, so an answer can point
 * at the exact page a claim came from.
 */
function citePage(
  ctx: ToolContext,
  url: string | undefined,
  title: string | undefined,
  body: string | undefined,
) {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  return registerSource(ctx.scratch, {
    url,
    ...(title ? { title } : {}),
    ...(body ? { snippet: body.replace(/\s+/g, ' ').trim().slice(0, 300) } : {}),
  });
}

/**
 * Browser tools.
 *
 * These are the primitives the model reasons over. They are deliberately
 * coarse: the model should think in terms of "navigate", "snapshot", "click
 * element e14" — not in terms of selectors and XPath.
 */

export interface BrowserToolDeps {
  browser: BrowserClient;
  /** Default timeout for browser commands. */
  timeoutMs?: number;
}

const schema: ToolDefinition['parameters'] = {
  type: 'object' as const,
  properties: {},
};

function def(
  name: string,
  description: string,
  parameters: Partial<ToolDefinition['parameters']>,
  category = 'browser',
  requiresApproval = false,
): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {}, ...parameters },
    runtime: 'browser',
    requiresApproval,
    category,
  };
}

export function createBrowserTools(deps: BrowserToolDeps): ToolHandler[] {
  const { browser } = deps;
  const timeout = deps.timeoutMs ?? 30_000;

  const guard = (call: ToolCall): string | null => {
    if (!browser.isConnected()) {
      return 'The Celeste browser extension is not connected. Ask the user to install it and reload the browser, then continue.';
    }
    return null;
  };

  const send = async <T>(
    call: ToolCall,
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<T | ReturnType<typeof fail>> => {
    const blocked = guard(call);
    if (blocked) return fail(call, 'NETWORK_ERROR', blocked, true);
    try {
      return await browser.send<T>(action, params, { timeoutMs: timeout });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(call, 'NETWORK_ERROR', message, true, { action, params });
    }
  };

  const navigate: ToolHandler = {
    definition: def(
      'browser_navigate',
      'Navigate the current tab to a URL. Waits for the page to load, then returns the page title, final URL and a fresh snapshot of the interactive elements.',
      {
        ...schema,
        properties: {
          url: { type: 'string', description: 'Absolute URL to open, e.g. https://example.com' },
        },
        required: ['url'],
      },
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_navigate');
      const result = await send<{ url: string; title: string; snapshot?: unknown }>(
        call,
        'navigate',
        { url: String(args.url) },
      );
      if (isFailure(result)) return result;
      const data = result as { url: string; title: string; snapshot?: unknown };
      return ok(
        call,
        `Navigated to ${data.title || data.url}`,
        data,
        `Opened ${data.url}\nTitle: ${data.title}\n\n${describeSnapshot(data.snapshot)}`,
      );
    },
  };

  const snapshot: ToolHandler = {
    definition: def(
      'browser_snapshot',
      'Capture the interactive structure of the current page as a compact list of elements, each with a stable reference (ref), role, accessible name and viewport position. ALWAYS take a snapshot before clicking or typing, and use the refs it returns.',
      {
        ...schema,
        properties: {
          maxElements: {
            type: 'integer',
            description: 'Maximum number of elements to return (default 300).',
            default: 300,
          },
          includeText: {
            type: 'boolean',
            description: 'Include the page text content alongside the element list.',
            default: false,
          },
        },
      },
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_snapshot');
      const result = await send<Record<string, unknown>>(call, 'snapshot', {
        maxElements: Number(args.maxElements ?? 300),
        includeText: args.includeText ?? false,
      });
      if (isFailure(result)) return result;
      return ok(
        call,
        `Snapshot captured (${countElements(result)} elements)`,
        result,
        describeSnapshot(result),
      );
    },
  };

  const click: ToolHandler = {
    definition: def(
      'browser_click',
      'Click an element by its ref from the latest snapshot, or at viewport coordinates (x, y) when the page has no accessible structure.',
      {
        ...schema,
        properties: {
          ref: { type: 'string', description: 'Element ref from the latest snapshot, e.g. "e14".' },
          x: { type: 'number', description: 'Viewport X coordinate in CSS pixels.' },
          y: { type: 'number', description: 'Viewport Y coordinate in CSS pixels.' },
          button: { type: 'string', description: 'Mouse button.', enum: ['left', 'right', 'middle'] },
        },
      },
      'browser',
      true,
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_click');
      const params: Record<string, unknown> = {};
      if (args.ref) params.ref = String(args.ref);
      if (args.x !== undefined) params.x = Number(args.x);
      if (args.y !== undefined) params.y = Number(args.y);
      if (args.button) params.button = String(args.button);

      if (!params.ref && (params.x === undefined || params.y === undefined)) {
        return fail(
          call,
          'INVALID_ARGS',
          'Provide either a ref from the latest snapshot, or both x and y viewport coordinates.',
        );
      }

      const result = await send<{ url?: string; navigated?: boolean }>(call, 'click', params);
      if (isFailure(result)) return result;
      const data = result as { url?: string; navigated?: boolean };
      return ok(
        call,
        data.navigated ? `Clicked and navigated to ${data.url}` : 'Clicked',
        data,
        data.navigated
          ? `Clicked. The page navigated to ${data.url}. Take a new snapshot to see the new state.`
          : 'Clicked. Take a new snapshot to confirm the page changed as expected.',
      );
    },
  };

  const type: ToolHandler = {
    definition: def(
      'browser_type',
      'Type text into an input, textarea or contenteditable element identified by a ref from the latest snapshot. Types character by character so that JavaScript frameworks observe each keystroke.',
      {
        ...schema,
        properties: {
          ref: { type: 'string', description: 'Element ref from the latest snapshot.' },
          text: { type: 'string', description: 'The text to type.' },
          clear: {
            type: 'boolean',
            description: 'Clear the field before typing. Default true.',
            default: true,
          },
          delayMs: {
            type: 'integer',
            description: 'Delay between keystrokes in milliseconds. Default 25.',
            default: 25,
          },
        },
        required: ['ref', 'text'],
      },
      'browser',
      true,
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_type');
      const result = await send<{ typed?: string }>(call, 'type', {
        ref: String(args.ref),
        text: String(args.text),
        clear: args.clear !== false,
        delayMs: Number(args.delayMs ?? 25),
      });
      if (isFailure(result)) return result;
      return ok(call, `Typed ${String(args.text).length} characters`, result, 'Text entered.');
    },
  };

  const fill: ToolHandler = {
    definition: def(
      'browser_fill',
      'Set the value of an input field in one shot (no per-keystroke events). Faster than browser_type but some frameworks only respond to real keystrokes — use browser_type if the value does not register.',
      {
        ...schema,
        properties: {
          ref: { type: 'string', description: 'Element ref from the latest snapshot.' },
          value: { type: 'string', description: 'The value to set.' },
        },
        required: ['ref', 'value'],
      },
      'browser',
      true,
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_fill');
      const result = await send(call, 'fill', {
        ref: String(args.ref),
        value: String(args.value),
      });
      if (isFailure(result)) return result;
      return ok(call, `Set field value (${String(args.value).length} characters)`, result);
    },
  };

  const press: ToolHandler = {
    definition: def(
      'browser_press',
      'Press a key, optionally on a focused element. Use for Enter (submit), Escape, Tab, Arrow keys, and shortcuts like Control+Enter.',
      {
        ...schema,
        properties: {
          ref: { type: 'string', description: 'Optional element to focus before pressing.' },
          key: { type: 'string', description: 'Key name, e.g. "Enter", "Escape", "Tab", "ArrowDown".' },
          modifiers: {
            type: 'array',
            description: 'Modifier keys held during the press.',
            items: { type: 'string', enum: ['Control', 'Alt', 'Shift', 'Meta'] },
          },
        },
        required: ['key'],
      },
      'browser',
      true,
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_press');
      const params: Record<string, unknown> = { key: String(args.key) };
      if (args.ref) params.ref = String(args.ref);
      if (Array.isArray(args.modifiers)) params.modifiers = args.modifiers;
      const result = await send(call, 'press', params);
      if (isFailure(result)) return result;
      return ok(call, `Pressed ${String(args.key)}`, result);
    },
  };

  const extract: ToolHandler = {
    definition: def(
      'browser_extract',
      'Extract the main content of the current page as clean Markdown, plus the page title, metadata and outbound links. Prefer this over reading raw text when you need to consume an article or a document.',
      {
        ...schema,
        properties: {
          selector: {
            type: 'string',
            description: 'Optional CSS selector to narrow the extraction to one region.',
          },
        },
      },
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_extract');
      const params: Record<string, unknown> = {};
      if (args.selector) params.selector = String(args.selector);
      const result = await send<{ markdown?: string; title?: string; url?: string }>(
        call,
        'extract',
        params,
      );
      if (isFailure(result)) return result;
      const data = result as { markdown?: string; title?: string; url?: string };
      const source = citePage(ctx, data.url, data.title, data.markdown);
      return {
        ...ok(call, `Extracted ${(data.markdown ?? '').length} characters`, data, data.markdown ?? ''),
        ...(source ? { sources: [source] } : {}),
      };
    },
  };

  const getText: ToolHandler = {
    definition: def(
      'browser_get_text',
      'Read the visible text of the current page (or of one element), with scripts, ads and boilerplate stripped.',
      {
        ...schema,
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector.' },
        },
      },
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_get_text');
      const params: Record<string, unknown> = {};
      if (args.selector) params.selector = String(args.selector);
      const result = await send<{ text?: string; url?: string; title?: string }>(call, 'getText', params);
      if (isFailure(result)) return result;
      const data = result as { text?: string; url?: string; title?: string };
      // getText does not report the URL, so ask the page for it.
      let url = data.url;
      if (!url) {
        const meta = await send<{ url?: string; title?: string }>(call, 'evaluate', {
          expression: '({ url: location.href, title: document.title })',
        });
        if (!isFailure(meta)) {
          const info = meta as { url?: string; title?: string };
          url = info.url;
          data.title = data.title ?? info.title;
        }
      }
      const source = citePage(ctx, url, data.title, data.text);
      return {
        ...ok(call, `Read ${(data.text ?? '').length} characters`, data, data.text ?? ''),
        ...(source ? { sources: [source] } : {}),
      };
    },
  };

  const screenshot: ToolHandler = {
    definition: def(
      'browser_screenshot',
      'Take a screenshot of the visible viewport. Use only when the DOM gives you nothing usable (canvas apps, charts, visual layout questions).',
      {
        ...schema,
        properties: {
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page.' },
          format: { type: 'string', description: 'Image format.', enum: ['png', 'jpeg'] },
        },
      },
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_screenshot');
      const result = await send<{ data?: string; mimeType?: string }>(call, 'screenshot', {
        fullPage: args.fullPage ?? false,
        format: args.format ?? 'png',
      });
      if (isFailure(result)) return result;
      const data = result as { data?: string; mimeType?: string };
      return ok(call, 'Screenshot captured', {
        mimeType: data.mimeType,
        width: 0,
        height: 0,
        // The UI renders the image; the model gets a note instead of raw bytes.
        imageBase64: data.data,
      });
    },
  };

  const evaluate: ToolHandler = {
    definition: def(
      'browser_evaluate',
      'Run a JavaScript expression in the page and return its value. Use for reading data that has no visible representation, or for extracting structured content from the DOM.',
      {
        ...schema,
        properties: {
          expression: {
            type: 'string',
            description: 'JavaScript expression to evaluate. Its result is JSON-serialised back.',
          },
        },
        required: ['expression'],
      },
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_evaluate');
      const result = await send<{ value?: unknown; error?: string }>(call, 'evaluate', {
        expression: String(args.expression),
      });
      if (isFailure(result)) return result;
      const data = result as { value?: unknown; error?: string };
      if (data.error) return fail(call, 'INTERNAL', `Evaluation failed: ${data.error}`);
      return ok(call, 'Evaluated expression', data, JSON.stringify(data.value ?? null, null, 2));
    },
  };

  const tabs: ToolHandler = {
    definition: def(
      'browser_tabs',
      'List, open, close or switch browser tabs. Use to open a second site for comparison, or to return to a tab you already visited.',
      {
        ...schema,
        properties: {
          action: {
            type: 'string',
            description: 'What to do.',
            enum: ['list', 'create', 'close', 'activate'],
            default: 'list',
          },
          url: { type: 'string', description: 'URL to open when creating a tab.' },
          tabId: { type: 'number', description: 'Target tab id.' },
        },
      },
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_tabs');
      const action = String(args.action ?? 'list');
      const params: Record<string, unknown> = { action };
      if (args.url) params.url = String(args.url);
      if (args.tabId !== undefined) params.tabId = Number(args.tabId);
      const result = await send(call, 'tabs', params);
      if (isFailure(result)) return result;
      return ok(call, `Tabs: ${action}`, result, JSON.stringify(result, null, 2));
    },
  };

  const waitFor: ToolHandler = {
    definition: def(
      'browser_wait_for',
      'Wait until an element matching a CSS selector appears, or until text appears on the page. Use after an action that triggers a slow update instead of guessing a delay.',
      {
        ...schema,
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for.' },
          text: { type: 'string', description: 'Text to wait for.' },
          timeoutMs: { type: 'integer', description: 'How long to wait. Default 10000.' },
        },
      },
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_wait_for');
      const params: Record<string, unknown> = {};
      if (args.selector) params.selector = String(args.selector);
      if (args.text) params.text = String(args.text);
      if (args.timeoutMs !== undefined) params.timeoutMs = Number(args.timeoutMs);
      const result = await send(call, 'waitFor', params);
      if (isFailure(result)) return result;
      return ok(call, 'Condition met', result);
    },
  };

  const scroll: ToolHandler = {
    definition: def(
      'browser_scroll',
      'Scroll the page (or a scrollable element) in a direction.',
      {
        ...schema,
        properties: {
          direction: {
            type: 'string',
            description: 'Scroll direction.',
            enum: ['up', 'down', 'left', 'right'],
            default: 'down',
          },
          amount: { type: 'integer', description: 'Pixels to scroll. Default 600.' },
          ref: { type: 'string', description: 'Optional element to scroll within.' },
        },
      },
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_scroll');
      const params: Record<string, unknown> = {
        direction: String(args.direction ?? 'down'),
        amount: Number(args.amount ?? 600),
      };
      if (args.ref) params.ref = String(args.ref);
      const result = await send(call, 'scroll', params);
      if (isFailure(result)) return result;
      return ok(call, `Scrolled ${params.direction}`, result);
    },
  };

  const network: ToolHandler = {
    definition: def(
      'browser_network',
      'List the background network requests the page has made (XHR and fetch), including JSON response bodies. This is often far cheaper than scraping rendered tables. Use action "clear" before performing an action whose responses you want to capture.',
      {
        ...schema,
        properties: {
          action: { type: 'string', description: '"list" or "clear".', enum: ['list', 'clear'], default: 'list' },
          filter: { type: 'string', description: 'Substring or URL pattern to filter by.' },
        },
      },
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_network');
      const params: Record<string, unknown> = { action: String(args.action ?? 'list') };
      if (args.filter) params.filter = String(args.filter);
      const result = await send(call, 'network', params);
      if (isFailure(result)) return result;
      return ok(call, `Network: ${params.action}`, result, JSON.stringify(result, null, 2));
    },
  };

  const challenge: ToolHandler = {
    definition: def(
      'browser_check_challenge',
      'Check whether the current page is showing a CAPTCHA or bot-verification challenge. If it is, stop and ask the user to solve it, then continue.',
      {},
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_check_challenge');
      const result = await send<{ detected?: boolean; kind?: string }>(call, 'challenge', {
        action: 'detect',
      });
      if (isFailure(result)) return result;
      const data = result as { detected?: boolean; kind?: string };
      if (data.detected) {
        return ok(
          call,
          `Verification challenge detected${data.kind ? ` (${data.kind})` : ''}`,
          data,
          'A verification challenge is blocking this page. Ask the user to complete it in the browser, then continue.',
        );
      }
      return ok(call, 'No challenge detected', data, 'No verification challenge is present.');
    },
  };

  const consoleLogs: ToolHandler = {
    definition: def(
      'browser_console',
      'Read the page console log. Useful for debugging why a form did not submit or a component failed to render.',
      {
        ...schema,
        properties: {
          action: { type: 'string', description: '"list" or "clear".', enum: ['list', 'clear'], default: 'list' },
        },
      },
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_console');
      const result = await send(call, 'console', { action: String(args.action ?? 'list') });
      if (isFailure(result)) return result;
      return ok(call, 'Console log', result, JSON.stringify(result, null, 2));
    },
  };

  const select: ToolHandler = {
    definition: def(
      'browser_select',
      'Choose an option in a <select> dropdown identified by a ref.',
      {
        ...schema,
        properties: {
          ref: { type: 'string', description: 'Element ref from the latest snapshot.' },
          value: { type: 'string', description: 'Option value to select.' },
        },
        required: ['ref', 'value'],
      },
      'browser',
      true,
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_select');
      const result = await send(call, 'select', {
        ref: String(args.ref),
        value: String(args.value),
      });
      if (isFailure(result)) return result;
      return ok(call, `Selected "${String(args.value)}"`, result);
    },
  };

  const hover: ToolHandler = {
    definition: def(
      'browser_hover',
      'Hover over an element, which is often required to reveal menus and tooltips.',
      {
        ...schema,
        properties: {
          ref: { type: 'string', description: 'Element ref from the latest snapshot.' },
        },
        required: ['ref'],
      },
      'browser',
      true,
    ),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_hover');
      const result = await send(call, 'hover', { ref: String(args.ref) });
      if (isFailure(result)) return result;
      return ok(call, 'Hovered', result);
    },
  };

  const back: ToolHandler = {
    definition: def('browser_back', 'Go back to the previous page in the tab history.', {}),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_back');
      const result = await send(call, 'back', {});
      if (isFailure(result)) return result;
      return ok(call, 'Navigated back', result);
    },
  };

  const forward: ToolHandler = {
    definition: def('browser_forward', 'Go forward to the next page in the tab history.', {}),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_forward');
      const result = await send(call, 'forward', {});
      if (isFailure(result)) return result;
      return ok(call, 'Navigated forward', result);
    },
  };

  const reload: ToolHandler = {
    definition: def('browser_reload', 'Reload the current page.', {}),
    async execute(args, ctx) {
      const call = toCall(ctx, 'browser_reload');
      const result = await send(call, 'reload', {});
      if (isFailure(result)) return result;
      return ok(call, 'Page reloaded', result);
    },
  };

  return [
    navigate,
    snapshot,
    click,
    type,
    fill,
    press,
    extract,
    getText,
    screenshot,
    evaluate,
    tabs,
    waitFor,
    scroll,
    network,
    challenge,
    consoleLogs,
    select,
    hover,
    back,
    forward,
    reload,
  ];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function toCall(ctx: ToolContext, name: string): ToolCall {
  return { id: `${name}_${Date.now()}`, name, arguments: {} };
}

function isFailure(value: unknown): value is ReturnType<typeof fail> {
  return Boolean(value && typeof value === 'object' && 'ok' in value && (value as { ok: boolean }).ok === false);
}

function countElements(snapshot: unknown): number {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  const elements = (snapshot as { elements?: unknown }).elements;
  return Array.isArray(elements) ? elements.length : 0;
}

/** Renders a snapshot into compact, model-friendly text. */
export function describeSnapshot(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return '(no snapshot)';
  const snap = snapshot as {
    url?: string;
    title?: string;
    elements?: Array<Record<string, unknown>>;
    text?: string;
  };

  const lines: string[] = [];
  if (snap.url) lines.push(`URL: ${snap.url}`);
  if (snap.title) lines.push(`TITLE: ${snap.title}`);

  const elements = snap.elements ?? [];
  if (elements.length) {
    lines.push(`ELEMENTS (${elements.length}):`);
    for (const el of elements.slice(0, 300)) {
      const ref = String(el.ref ?? '');
      const role = String(el.role ?? '');
      const name = String(el.name ?? '');
      const tag = el.tag ? `<${el.tag}>` : '';
      lines.push(`  ${ref} ${role}${tag} ${name}`.trimEnd());
    }
  }

  if (snap.text) {
    lines.push('TEXT:');
    lines.push(snap.text.slice(0, 4000));
  }

  return lines.join('\n');
}
