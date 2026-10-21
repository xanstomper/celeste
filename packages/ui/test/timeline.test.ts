import { describe, expect, it } from 'vitest';

import type { TaskState, ToolResult } from '@celeste/protocol';
import { buildCitations, citedNumbers, collectSources } from '../src/lib/citations';
import {
  applyEventToTask,
  buildTimeline,
  buildTimelineFromTask,
  mergeTimeline,
  type TimelineItem,
} from '../src/state/timeline';

const source = (n: number, domain: string) => ({
  n,
  title: `${domain} page`,
  url: `https://${domain}/page`,
  domain,
});

describe('citations', () => {
  it('reads numbers in order of first appearance', () => {
    expect(citedNumbers('A claim [3], another [1], again [3] and [2, 4].')).toEqual([3, 1, 2, 4]);
  });

  it('renumbers by appearance so a single source reads as 1', () => {
    const index = new Map([
      [9, source(9, 'nasa.gov')],
    ]);
    const citations = buildCitations('The telescope launched in 2021 [9].', index);

    expect(citations.refs).toHaveLength(1);
    expect(citations.refs[0]?.display).toBe(1);
    expect(citations.byNumber.get(9)?.display).toBe(1);
  });

  it('drops citations that do not resolve to a source', () => {
    const citations = buildCitations('Claim [7].', new Map());
    expect(citations.refs).toEqual([]);
    expect(citations.byNumber.size).toBe(0);
  });

  it('keeps a stable number for the same page across a task', () => {
    const items: TimelineItem[] = [
      {
        kind: 'tool',
        id: 't1',
        at: 1,
        callId: 'c1',
        toolName: 'web_search',
        arguments: {},
        status: 'ok',
        summary: 'Found 2 sources',
        durationMs: 10,
        data: undefined,
        error: undefined,
        sources: [source(1, 'nasa.gov'), source(2, 'wikipedia.org')],
      },
      {
        kind: 'tool',
        id: 't2',
        at: 2,
        callId: 'c2',
        toolName: 'web_open',
        arguments: {},
        status: 'ok',
        summary: 'Read',
        durationMs: 10,
        data: undefined,
        error: undefined,
        // The same page discovered by a later search must not take a new number.
        sources: [source(2, 'wikipedia.org')],
      },
    ] as TimelineItem[];

    const index = collectSources(items);
    expect([...index.keys()]).toEqual([1, 2]);
  });
});

describe('timeline suggestions', () => {
  const event = (suggestions: string[]) =>
    ({ type: 'task.suggestions', taskId: 't', suggestions, at: 10 }) as const;

  it('appends follow-up questions after the answer', () => {
    const items = buildTimeline([
      { type: 'task.message', taskId: 't', message: { role: 'user', content: 'Hi' }, at: 1 },
      {
        type: 'task.message',
        taskId: 't',
        message: { role: 'assistant', content: 'Hello' },
        at: 2,
      },
      event(['Why?', 'How?']),
    ]);

    expect(items.at(-1)?.kind).toBe('suggestions');
  });

  it('clears the previous questions when a new question arrives', () => {
    const items = buildTimeline([
      event(['Old follow-up?']),
      { type: 'task.message', taskId: 't', message: { role: 'user', content: 'Next' }, at: 20 },
    ]);

    expect(items.some((item) => item.kind === 'suggestions')).toBe(false);
  });

  it('keeps restored questions as a footer, not as history', () => {
    const snapshot: TimelineItem[] = [
      { kind: 'suggestions', id: 's', at: 1, questions: ['Restored?'] },
      {
        kind: 'message',
        id: 'm',
        at: 2,
        role: 'assistant',
        text: 'Answer',
        name: undefined,
        toolCalls: undefined,
      },
    ];
    const streamed: TimelineItem[] = [
      {
        kind: 'message',
        id: 's2',
        at: 3,
        role: 'user',
        text: 'New question',
        name: undefined,
        toolCalls: undefined,
      },
    ];

    const merged = mergeTimeline(snapshot, streamed);
    expect(merged.at(-1)?.kind).toBe('suggestions');
  });

  it('does not decorate a successful run with a completion divider', () => {
    const items = buildTimeline([
      { type: 'task.status', taskId: 't', status: 'running', at: 1 },
      { type: 'task.status', taskId: 't', status: 'completed', at: 2 },
      { type: 'task.done', taskId: 't', status: 'completed', at: 3 },
    ]);

    expect(items.filter((item) => item.kind === 'status')).toHaveLength(0);
  });

  it('marks a run that ended badly', () => {
    const items = buildTimeline([
      { type: 'task.status', taskId: 't', status: 'running', at: 1 },
      { type: 'task.status', taskId: 't', status: 'failed', at: 2 },
      { type: 'task.done', taskId: 't', status: 'failed', at: 3 },
    ]);

    const statuses = items.filter((item) => item.kind === 'status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.kind === 'status' && statuses[0].status).toBe('failed');
  });

  it('stores questions in the snapshot of a restored task', () => {
    const task = {
      id: 't',
      title: 'Title',
      status: 'completed',
      plan: [],
      messages: [{ role: 'user', content: 'Q' }],
      scratch: {},
      artifacts: [],
      sources: [source(1, 'nasa.gov')],
      suggestions: ['What next?'],
      createdAt: 1,
      updatedAt: 2,
    } as unknown as TaskState;

    const items = buildTimelineFromTask(task);
    expect(items.some((item) => item.kind === 'suggestions')).toBe(true);
  });
});

describe('tool results', () => {
  it('carries sources into the timeline', () => {
    const result: ToolResult = {
      id: 'c1',
      name: 'web_search',
      ok: true,
      summary: 'Found 1 source',
      sources: [source(1, 'nasa.gov')],
    };

    expect(result.sources?.[0]?.domain).toBe('nasa.gov');
  });
});

describe('streaming', () => {
  it('accumulates deltas into one preview, then replaces it with the message', () => {
    const events = [
      { type: 'task.delta', taskId: 't', delta: 'The ', at: 1 },
      { type: 'task.delta', taskId: 't', delta: 'answer', at: 2 },
    ] as const;

    const streaming = buildTimeline(events);
    const preview = streaming.filter((item) => item.kind === 'streaming');

    expect(preview).toHaveLength(1);
    expect(preview[0]?.kind === 'streaming' ? preview[0].text : '').toBe('The answer');

    const finished = buildTimeline([
      ...events,
      {
        type: 'task.message',
        taskId: 't',
        message: { role: 'assistant', content: 'The answer' },
        at: 3,
      },
    ]);

    expect(finished.some((item) => item.kind === 'streaming')).toBe(false);
    expect(
      finished.filter((item) => item.kind === 'message' && item.role === 'assistant'),
    ).toHaveLength(1);
  });

  it('starts a fresh preview for the next answer', () => {
    const items = buildTimeline([
      { type: 'task.delta', taskId: 't', delta: 'First', at: 1 },
      {
        type: 'task.message',
        taskId: 't',
        message: { role: 'assistant', content: 'First' },
        at: 2,
      },
      { type: 'task.message', taskId: 't', message: { role: 'user', content: 'Again' }, at: 3 },
      { type: 'task.delta', taskId: 't', delta: 'Second', at: 4 },
    ]);

    const previews = items.filter((item) => item.kind === 'streaming');
    expect(previews).toHaveLength(1);
    expect(previews[0]?.kind === 'streaming' ? previews[0].text : '').toBe('Second');
  });
});


describe('canvas', () => {
  const canvas = {
    id: 'canvas_t',
    kind: 'visual' as const,
    title: 'Chart',
    content: '<h1>x</h1>',
    updatedAt: 5,
  };

  it('folds a canvas event into one card', () => {
    const items = buildTimeline([{ type: 'task.canvas', taskId: 't', canvas, at: 5 }]);
    expect(items.filter((item) => item.kind === 'canvas')).toHaveLength(1);
  });

  it('updates the card in place rather than stacking them', () => {
    const items = buildTimeline([
      { type: 'task.canvas', taskId: 't', canvas, at: 5 },
      {
        type: 'task.canvas',
        taskId: 't',
        canvas: { ...canvas, title: 'Chart v2', updatedAt: 6 },
        at: 6,
      },
    ]);

    const cards = items.filter((item) => item.kind === 'canvas');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind === 'canvas' ? cards[0].canvas.title : '').toBe('Chart v2');
  });

  it('applies a canvas event to the task snapshot', () => {
    const task = {
      id: 't',
      title: 'x',
      status: 'running',
      plan: [],
      messages: [],
      scratch: {},
      artifacts: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as TaskState;

    const next = applyEventToTask(task, { type: 'task.canvas', taskId: 't', canvas, at: 6 });
    expect(next.canvas?.title).toBe('Chart');
  });
});

describe('browser action', () => {
  const action = {
    id: 'act_1',
    action: 'click' as const,
    point: { x: 100, y: 200 },
    ref: 'e14',
    url: 'https://example.com',
    at: 10,
  };

  it('folds a browser action event into the timeline', () => {
    const items = buildTimeline([{ type: 'task.browser.action', taskId: 't', action, at: 10 }]);
    expect(items.filter((item) => item.kind === 'browser')).toHaveLength(1);
  });

  it('records browser action into task state history', () => {
    const task = {
      id: 't',
      title: 'x',
      status: 'running',
      plan: [],
      messages: [],
      scratch: {},
      artifacts: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as TaskState;

    const next = applyEventToTask(task, { type: 'task.browser.action', taskId: 't', action, at: 10 });
    expect(next.activeBrowser?.action).toBe('click');
    expect(next.browserHistory).toHaveLength(1);
  });
});


describe('terminal dividers', () => {
  it('does not stack two identical failure rows', () => {
    const items = buildTimeline([
      { type: 'task.done', taskId: 't', status: 'failed', at: 1 },
      { type: 'task.done', taskId: 't', status: 'failed', at: 2 },
    ]);
    expect(items.filter((item) => item.kind === 'status')).toHaveLength(1);
  });

  it('keeps a failure divider above a later answer', () => {
    const items = buildTimeline([
      { type: 'task.done', taskId: 't', status: 'failed', at: 1 },
      {
        type: 'task.message',
        taskId: 't',
        message: { role: 'assistant', content: 'Recovered.' },
        at: 2,
      },
    ]);
    expect(items.filter((item) => item.kind === 'status')).toHaveLength(1);
    expect(items.filter((item) => item.kind === 'message')).toHaveLength(1);
  });
});


describe('failure reasons', () => {
  it('carries the error from task.done into the snapshot and timeline', () => {
    const task = {
      id: 't',
      title: 'Title',
      status: 'running',
      plan: [],
      messages: [],
      scratch: {},
      artifacts: [],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as TaskState;

    const updated = applyEventToTask(task, {
      type: 'task.done',
      taskId: 't',
      status: 'failed',
      error: { code: 'INTERNAL', message: 'provider exploded' },
      at: 2,
    });

    expect(updated.error?.message).toBe('provider exploded');
    expect(buildTimelineFromTask(updated).some((item) => item.kind === 'error')).toBe(true);
  });
});
