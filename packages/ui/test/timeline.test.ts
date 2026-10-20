import { describe, expect, it } from 'vitest';

import type { TaskState, ToolResult } from '@celeste/protocol';
import { buildCitations, citedNumbers, collectSources } from '../src/lib/citations';
import {
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
