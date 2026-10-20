import type { ToolDefinition } from '@celeste/protocol';
import type { ToolHandler } from './types.js';
import { fail, ok } from './types.js';

/**
 * Memory tools.
 *
 * The scratchpad gives the agent a place to keep facts it will need later in
 * a long task — extracted prices, URLs, intermediate findings — without
 * spending context window on every re-read.
 */

export function createMemoryTools(): ToolHandler[] {
  const remember: ToolHandler = {
    definition: {
      name: 'memory_remember',
      description:
        'Store a fact for later use in this task. Use it for anything you would otherwise have to re-fetch: extracted data, URLs, intermediate conclusions, credentials you have been told to reuse.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              'Short stable identifier, e.g. "pricing-acme" or "login-url". Use a prefix/suffix to group related facts.',
          },
          value: { type: 'string', description: 'The fact to store.' },
          source: {
            type: 'string',
            description: 'Where the fact came from (usually a URL).',
          },
        },
        required: ['key', 'value'],
      },
      runtime: 'local',
      requiresApproval: false,
      category: 'memory',
    },
    async execute(args, ctx) {
      const call = { id: `memory_remember_${Date.now()}`, name: 'memory_remember', arguments: args };
      const key = String(args.key ?? '');
      if (!key) return fail(call, 'INVALID_ARGS', 'A key is required.');

      ctx.scratch.set(key, {
        value: String(args.value ?? ''),
        source: args.source ? String(args.source) : undefined,
        storedAt: Date.now(),
      });

      const count = ctx.scratch.keys().length;
      return ok(call, `Remembered "${key}"`, { key, count });
    },
  };

  const recall: ToolHandler = {
    definition: {
      name: 'memory_recall',
      description:
        'Read back everything you stored with memory_remember during this task. Use it before re-visiting a page you have already extracted data from.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Optional key to fetch a single entry. Omit to list everything.',
          },
        },
      },
      runtime: 'local',
      requiresApproval: false,
      category: 'memory',
    },
    async execute(args, ctx) {
      const call = { id: `memory_recall_${Date.now()}`, name: 'memory_recall', arguments: args };
      const keys = ctx.scratch.keys();

      if (args.key) {
        const entry = ctx.scratch.get(String(args.key));
        if (entry === undefined) {
          return fail(call, 'NOT_FOUND', `Nothing stored under "${String(args.key)}".`);
        }
        return ok(call, `Recalled "${String(args.key)}"`, entry, JSON.stringify(entry, null, 2));
      }

      if (keys.length === 0) {
        return ok(call, 'Memory is empty', {}, 'Nothing stored yet.');
      }

      const lines = keys.map((k) => {
        const entry = ctx.scratch.get(k) as { value?: unknown; source?: unknown } | undefined;
        const value = typeof entry?.value === 'string' ? entry.value : JSON.stringify(entry);
        const source = entry?.source ? ` (source: ${entry.source})` : '';
        return `• ${k}${source}: ${value}`;
      });

      return ok(call, `${keys.length} memories`, { keys }, lines.join('\n'));
    },
  };

  const forget: ToolHandler = {
    definition: {
      name: 'memory_forget',
      description: 'Delete a stored fact.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Key to delete.' } },
        required: ['key'],
      },
      runtime: 'local',
      requiresApproval: false,
      category: 'memory',
    },
    async execute(args, ctx) {
      const call = { id: `memory_forget_${Date.now()}`, name: 'memory_forget', arguments: args };
      const key = String(args.key ?? '');
      ctx.scratch.delete(key);
      return ok(call, `Forgot "${key}"`, { key });
    },
  };

  const summarise: ToolHandler = {
    definition: {
      name: 'memory_summarise',
      description:
        'Summarise everything known so far about the current task into a compact, reusable brief: the goal, what has been done, what is left, the URLs visited and the files created. Use it before a long final answer.',
      parameters: {
        type: 'object',
        properties: {
          focus: {
            type: 'string',
            description: 'Optional area to emphasise, e.g. "sources" or "files".',
          },
        },
      },
      runtime: 'local',
      requiresApproval: false,
      category: 'memory',
    },
    async execute(args, ctx) {
      const call = { id: `memory_summarise_${Date.now()}`, name: 'memory_summarise', arguments: args };
      const task = ctx.store.get(ctx.taskId);
      const keys = ctx.scratch.keys();

      const sections: string[] = [];
      sections.push(`TASK: ${task?.title ?? '(unknown)'}`);
      if (task?.plan?.length) {
        sections.push('PLAN:');
        for (const step of task.plan) {
          sections.push(`  [${step.status}] ${step.description}`);
        }
      }
      if (keys.length) {
        sections.push('FACTS:');
        for (const k of keys) {
          const entry = ctx.scratch.get(k) as { value?: unknown; source?: unknown } | undefined;
          const value = typeof entry?.value === 'string' ? entry.value : JSON.stringify(entry);
          sections.push(`  ${k}: ${value}${entry?.source ? ` [${entry.source}]` : ''}`);
        }
      }
      if (task?.artifacts?.length) {
        sections.push('FILES:');
        for (const artifact of task.artifacts) {
          sections.push(`  ${artifact.path} (${artifact.kind}, ${artifact.bytes} bytes)`);
        }
      }

      return ok(
        call,
        `Summarised ${keys.length} facts and ${task?.artifacts?.length ?? 0} files`,
        { facts: keys, artifacts: task?.artifacts ?? [] },
        sections.join('\n'),
      );
    },
  };

  return [remember, recall, forget, summarise];
}
