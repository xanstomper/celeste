import { promises as fs } from 'node:fs';
import path from 'node:path';
// Type-only. The runtime is loaded lazily so the server can answer the MCP
// handshake immediately — coding agents enforce short startup timeouts.
import type { RunningDaemon } from '@celeste/core';
import { McpServer, textResult } from './server.js';
import type { McpToolSchema } from './server.js';

/**
 * Celeste as an MCP server.
 *
 * Any coding agent — Claude Code, Cline, Mochi, or your own harness — can
 * drive the user's real browser through these tools, closing the loop between
 * "write code" and "verify it in the browser".
 */

const TOOLS: McpToolSchema[] = [
  {
    name: 'celeste_navigate',
    description:
      'Navigate the browser to a URL and return the page title plus a snapshot of interactive elements.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL' } },
      required: ['url'],
    },
  },
  {
    name: 'celeste_snapshot',
    description:
      'Capture the interactive structure of the current page. Each element gets a stable ref (e.g. "e14") that can be passed to click/type tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'celeste_click',
    description: 'Click an element by its ref from the latest snapshot.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Element ref, e.g. "e14"' } },
      required: ['ref'],
    },
  },
  {
    name: 'celeste_type',
    description: 'Type text into an input element identified by its ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'celeste_extract',
    description: 'Extract the main content of the current page as clean Markdown.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'celeste_evaluate',
    description:
      'Run a JavaScript expression in the page and return its JSON-serialised value.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JS expression' } },
      required: ['expression'],
    },
  },
  {
    name: 'celeste_screenshot',
    description: 'Take a screenshot of the visible viewport and return it as an image.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'celeste_network',
    description:
      'List background network requests (XHR/fetch) the page has made, including JSON response bodies.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'celeste_tabs',
    description: 'List the open browser tabs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'celeste_read_file',
    description: 'Read a UTF-8 text file from disk.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path' } },
      required: ['path'],
    },
  },
  {
    name: 'celeste_write_file',
    description: 'Write text to a file on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File contents' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'celeste_console',
    description: 'Read the browser console log of the current page.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function main(): Promise<void> {
  let runtime: RunningDaemon | null = null;

  const server = new McpServer(process.stdin, process.stdout, {
    name: 'celeste',
    version: '0.1.0',
  });

  const browser = async () => {
    if (!runtime) {
      const { startDaemon } = await import('@celeste/core');
      runtime = await startDaemon({ serve: false, serveBridge: true });
    }
    return runtime;
  };

  const bridge = async () => (await browser()).bridge;

  const send = async (
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const b = await bridge();
    if (!b.isConnected) {
      throw new Error(
        'The Celeste browser extension is not connected. Install it in Brave/Chromium and reload the extension.',
      );
    }
    return b.send(action, params);
  };

  for (const tool of TOOLS) {
    server.registerTool(tool, async (args) => {
      switch (tool.name) {
        case 'celeste_navigate': {
          const result = (await send('navigate', { url: String(args.url) })) as {
            url: string;
            title: string;
            snapshot?: unknown;
          };
          return textResult(
            `Navigated to ${result.url}\nTitle: ${result.title}\n\n${describeSnapshot(result.snapshot)}`,
          );
        }

        case 'celeste_snapshot': {
          const result = await send('snapshot', {});
          return textResult(describeSnapshot(result));
        }

        case 'celeste_click': {
          const result = (await send('click', { ref: String(args.ref) })) as {
            url?: string;
            navigated?: boolean;
          };
          return textResult(
            result.navigated
              ? `Clicked. The page navigated to ${result.url}.`
              : 'Clicked. Take a new snapshot to confirm the change.',
          );
        }

        case 'celeste_type': {
          await send('type', { ref: String(args.ref), text: String(args.text) });
          return textResult(`Typed into ${String(args.ref)}.`);
        }

        case 'celeste_extract': {
          const result = (await send('extract', {})) as { markdown?: string };
          return textResult(result.markdown ?? '(no content)');
        }

        case 'celeste_evaluate': {
          const result = (await send('evaluate', { expression: String(args.expression) })) as {
            value?: unknown;
            error?: string;
          };
          if (result.error) return textResult(`Error: ${result.error}`, true);
          return textResult(JSON.stringify(result.value ?? null, null, 2));
        }

        case 'celeste_screenshot': {
          const result = (await send('screenshot', { format: 'png' })) as {
            data?: string;
            mimeType?: string;
          };
          return {
            content: [
              { type: 'image', data: result.data ?? '', mimeType: result.mimeType ?? 'image/png' },
            ],
          };
        }

        case 'celeste_network': {
          const result = await send('network', { action: 'list' });
          return textResult(JSON.stringify(result, null, 2));
        }

        case 'celeste_tabs': {
          const result = await send('tabs', { action: 'list' });
          return textResult(JSON.stringify(result, null, 2));
        }

        case 'celeste_console': {
          const result = await send('console', { action: 'list' });
          return textResult(JSON.stringify(result, null, 2));
        }

        case 'celeste_read_file': {
          const target = String(args.path);
          const content = await fs.readFile(target, 'utf8');
          return textResult(content);
        }

        case 'celeste_write_file': {
          const target = String(args.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, String(args.content ?? ''), 'utf8');
          return textResult(`Wrote ${target}.`);
        }

        default:
          return textResult(`Unhandled tool ${tool.name}`, true);
      }
    });
  }

  const cleanup = async () => {
    if (runtime) await runtime.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());

  await server.serve();
}

function describeSnapshot(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return '(no snapshot)';
  const snap = snapshot as {
    url?: string;
    title?: string;
    elements?: Array<Record<string, unknown>>;
  };
  const lines: string[] = [];
  if (snap.url) lines.push(`URL: ${snap.url}`);
  if (snap.title) lines.push(`TITLE: ${snap.title}`);
  const elements = snap.elements ?? [];
  if (elements.length) {
    lines.push(`ELEMENTS (${elements.length}):`);
    for (const el of elements.slice(0, 250)) {
      lines.push(
        `  ${String(el.ref ?? '')} ${String(el.role ?? '')} ${String(el.name ?? '')}`.trimEnd(),
      );
    }
  }
  return lines.join('\n');
}

main().catch((err) => {
  process.stderr.write(`celeste-mcp failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
