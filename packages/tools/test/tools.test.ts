import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolCall } from '@celeste/protocol';
import { ToolRegistry, validateArguments } from '../src/registry.js';
import { createFileTools } from '../src/file-tools.js';
import { createMemoryTools } from '../src/memory-tools.js';
import { createBrowserTools } from '../src/browser-tools.js';
import { resolveInside } from '../src/file-tools.js';
import type { ToolContext } from '../src/types.js';

let tmpDir: string;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const scratch = new Map<string, unknown>();
  return {
    taskId: 'task_test',
    signal: new AbortController().signal,
    bus: { publish: () => {} },
    store: { get: () => undefined },
    outputDir: tmpDir,
    approval: { request: async () => true },
    scratch: {
      get: <T = unknown>(key: string) => scratch.get(key) as T | undefined,
      set: (key, value) => void scratch.set(key, value),
      delete: (key) => void scratch.delete(key),
      keys: () => [...scratch.keys()],
    },
    emitArtifact: () => {},
    ...overrides,
  };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${name}`, name, arguments: args };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'celeste-tools-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('validateArguments', () => {
  const definition = {
    name: 'demo',
    description: 'demo',
    parameters: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' as const },
        count: { type: 'integer' as const },
        flag: { type: 'boolean' as const },
        items: { type: 'array' as const, items: { type: 'string' as const } },
        mode: { type: 'string' as const, enum: ['a', 'b'] },
      },
      required: ['name'],
    },
    runtime: 'local' as const,
    requiresApproval: false,
  };

  it('accepts valid arguments', () => {
    expect(
      validateArguments(definition, { name: 'x', count: 3, flag: true, items: ['a'] }).valid,
    ).toBe(true);
  });

  it('rejects a missing required argument', () => {
    const result = validateArguments(definition, {});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('name');
  });

  it('rejects a wrong primitive type', () => {
    expect(validateArguments(definition, { name: 42 }).valid).toBe(false);
  });

  it('rejects a non-integer for an integer field', () => {
    expect(validateArguments(definition, { name: 'x', count: 1.5 }).valid).toBe(false);
  });

  it('rejects a value outside an enum', () => {
    const result = validateArguments(definition, { name: 'x', mode: 'z' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('mode');
  });

  it('rejects a wrongly typed array item', () => {
    expect(validateArguments(definition, { name: 'x', items: [1, 2] }).valid).toBe(false);
  });
});

describe('file tools', () => {
  function registryWithFiles() {
    const registry = new ToolRegistry();
    registry.registerAll(createFileTools({ allowedRoots: [tmpDir] }));
    return registry;
  }

  it('writes and reads a file', async () => {
    const registry = registryWithFiles();
    const target = path.join(tmpDir, 'notes.txt');

    const written = await registry.execute(
      call('file_write', { path: target, content: 'hello world' }),
      makeContext(),
    );
    expect(written.ok).toBe(true);

    const read = await registry.execute(call('file_read', { path: target }), makeContext());
    expect(read.ok).toBe(true);
    expect(read.text).toContain('hello world');
    expect(read.text).toContain('1: hello world');
  });

  it('refuses to write outside the allowed roots', async () => {
    const registry = registryWithFiles();
    const result = await registry.execute(
      call('file_write', { path: '/etc/celeste-should-not-exist', content: 'nope' }),
      makeContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('outside the allowed directories');
  });

  it('lists a directory', async () => {
    const registry = registryWithFiles();
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a');
    await fs.mkdir(path.join(tmpDir, 'sub'));
    const result = await registry.execute(call('file_list', { path: tmpDir }), makeContext());
    expect(result.ok).toBe(true);
    expect(result.text).toContain('a.txt');
    expect(result.text).toContain('sub');
  });

  it('reports a missing file clearly', async () => {
    const registry = registryWithFiles();
    const result = await registry.execute(
      call('file_read', { path: path.join(tmpDir, 'nope.txt') }),
      makeContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('deletes a file', async () => {
    const registry = registryWithFiles();
    const target = path.join(tmpDir, 'gone.txt');
    await fs.writeFile(target, 'x');
    const result = await registry.execute(call('file_delete', { path: target }), makeContext());
    expect(result.ok).toBe(true);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('searches by file name', async () => {
    const registry = registryWithFiles();
    await fs.writeFile(path.join(tmpDir, 'needle.txt'), 'content');
    await fs.writeFile(path.join(tmpDir, 'haystack.txt'), 'content');
    const result = await registry.execute(
      call('file_search', { path: tmpDir, query: 'needle' }),
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain('needle.txt');
    expect(result.text).not.toContain('haystack.txt');
  });
});

describe('resolveInside', () => {
  it('allows a path inside the root', () => {
    expect(() => resolveInside([], '/tmp/ok/file.txt', ['/tmp/ok'])).not.toThrow();
  });

  it('allows the root itself', () => {
    expect(() => resolveInside([], '/tmp/ok', ['/tmp/ok'])).not.toThrow();
  });

  it('blocks a sibling directory with a shared prefix', () => {
    expect(() => resolveInside([], '/tmp/okevil/file.txt', ['/tmp/ok'])).toThrow();
  });

  it('blocks traversal', () => {
    expect(() => resolveInside([], '/tmp/ok/../etc/passwd', ['/tmp/ok'])).toThrow();
  });
});

describe('memory tools', () => {
  function registryWithMemory() {
    const registry = new ToolRegistry();
    registry.registerAll(createMemoryTools());
    return registry;
  }

  it('stores and recalls a fact', async () => {
    const registry = registryWithMemory();
    const ctx = makeContext();

    const stored = await registry.execute(
      call('memory_remember', { key: 'price', value: '$29/mo', source: 'https://example.com' }),
      ctx,
    );
    expect(stored.ok).toBe(true);

    const recalled = await registry.execute(call('memory_recall', {}), ctx);
    expect(recalled.ok).toBe(true);
    expect(recalled.text).toContain('$29/mo');
    expect(recalled.text).toContain('https://example.com');
  });

  it('reports when the memory is empty', async () => {
    const registry = registryWithMemory();
    const result = await registry.execute(call('memory_recall', {}), makeContext());
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Nothing stored');
  });

  it('fails cleanly when a key is missing', async () => {
    const registry = registryWithMemory();
    const result = await registry.execute(call('memory_recall', { key: 'nope' }), makeContext());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

describe('browser tools', () => {
  const disconnected = {
    isConnected: () => false,
    send: async () => {
      throw new Error('should not be called');
    },
  };

  it('fails with a helpful message when the extension is not connected', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(createBrowserTools({ browser: disconnected }));
    const result = await registry.execute(
      call('browser_navigate', { url: 'https://example.com' }),
      makeContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.message).toContain('extension is not connected');
  });

  it('requires either a ref or coordinates for a click', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(createBrowserTools({ browser: disconnected }));
    const result = await registry.execute(call('browser_click', {}), makeContext());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGS');
  });

  it('sends the right browser command', async () => {
    const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
    const registry = new ToolRegistry();
    registry.registerAll(
      createBrowserTools({
        browser: {
          isConnected: () => true,
          send: async (action, params) => {
            sent.push({ action, params: params ?? {} });
            return { url: 'https://example.com', title: 'Example' };
          },
        },
      }),
    );

    const result = await registry.execute(
      call('browser_navigate', { url: 'https://example.com' }),
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(sent[0]?.action).toBe('navigate');
    expect(sent[0]?.params.url).toBe('https://example.com');
  });
});
