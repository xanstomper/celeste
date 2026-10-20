import { describe, expect, it } from 'vitest';
import type { CanvasState, DaemonEvent, ToolCall } from '@celeste/protocol';
import { ToolRegistry } from '../src/registry.js';
import { createCanvasTools } from '../src/canvas-tools.js';
import type { ToolContext } from '../src/types.js';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'call_1', name, arguments: args };
}

function makeContext() {
  const events: DaemonEvent[] = [];
  let canvas: CanvasState | undefined;
  const ctx = {
    taskId: 'task_test',
    signal: new AbortController().signal,
    bus: { publish: (event: DaemonEvent) => events.push(event) },
    store: {
      get: () => undefined,
      setCanvas: (_id: string, value: CanvasState) => {
        canvas = value;
      },
    },
    outputDir: '/tmp',
    approval: { request: async () => true },
    scratch: {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      keys: () => [],
    },
    emitArtifact: () => {},
  } as unknown as ToolContext;
  return { ctx, events, canvas: () => canvas };
}

describe('canvas_write', () => {
  it('writes a document canvas and publishes it', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(createCanvasTools());
    const { ctx, events, canvas } = makeContext();

    const result = await registry.execute(
      call('canvas_write', { kind: 'document', title: 'Evidence map', content: '# Findings' }),
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(canvas()?.kind).toBe('document');
    expect(canvas()?.title).toBe('Evidence map');
    expect(events[0]?.type).toBe('task.canvas');
  });

  it('rejects a visual with no content', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(createCanvasTools());
    const { ctx } = makeContext();

    const result = await registry.execute(
      call('canvas_write', { kind: 'visual', title: 'Empty', content: '   ' }),
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGS');
  });

  it('keeps the files of a project canvas', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(createCanvasTools());
    const { ctx, canvas } = makeContext();

    const result = await registry.execute(
      call('canvas_write', {
        kind: 'project',
        title: 'Starter',
        files: [
          { path: 'index.html', content: '<h1>hi</h1>' },
          { path: 'style.css', content: 'body { color: teal }' },
        ],
      }),
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(canvas()?.files).toHaveLength(2);
    expect(canvas()?.files?.[1]?.path).toBe('style.css');
  });
});

describe('generate_image', () => {
  it('builds a pollinations URL and shows it in the image canvas', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(createCanvasTools());
    const { ctx, canvas } = makeContext();

    const result = await registry.execute(
      call('generate_image', { prompt: 'a teal comet over a dark ocean', width: 768, height: 512 }),
      ctx,
    );

    expect(result.ok).toBe(true);
    const url = canvas()?.content ?? '';
    expect(url).toContain('image.pollinations.ai/prompt/');
    expect(url).toContain('width=768');
    expect(url).toContain('height=512');
    expect(canvas()?.kind).toBe('image');
  });
});
