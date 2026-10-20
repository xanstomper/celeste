import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { McpServer, textResult } from '../src/server.js';
import type { JsonRpcResponse } from '../src/server.js';

/**
 * Drives an McpServer over an in-memory stream pair and collects the
 * responses it writes.
 */
function harness(tools: Array<{ name: string; description: string }> = []) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new McpServer(input, output, { name: 'celeste-test', version: '0.0.1' });

  for (const tool of tools) {
    server.registerTool(
      {
        name: tool.name,
        description: tool.description,
        inputSchema: { type: 'object', properties: {} },
      },
      async (args) => textResult(`called ${tool.name} with ${JSON.stringify(args)}`),
    );
  }

  const responses: JsonRpcResponse[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) responses.push(JSON.parse(line) as JsonRpcResponse);
      index = buffer.indexOf('\n');
    }
  });

  void server.serve();

  const send = (message: unknown) => {
    input.write(`${JSON.stringify(message)}\n`);
  };

  /** Writes a raw line, bypassing JSON serialisation. */
  const sendRaw = (line: string) => {
    input.write(`${line}\n`);
  };

  /** Sends a request and waits for the matching response. */
  const request = async (method: string, params?: unknown, id: number | string = 1) => {
    send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    const started = Date.now();
    while (Date.now() - started < 2000) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`No response for ${method}`);
  };

  return { server, send, sendRaw, request, responses };
}

describe('McpServer', () => {
  it('answers initialize with protocol info', async () => {
    const h = harness();
    const res = await h.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });

    expect(res.error).toBeUndefined();
    const result = res.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe('celeste-test');
  });

  it('lists registered tools', async () => {
    const h = harness([{ name: 'celeste_navigate', description: 'Navigate' }]);
    const res = await h.request('tools/list');
    const result = res.result as { tools: Array<{ name: string; description: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe('celeste_navigate');
    expect(result.tools[0]?.description).toBe('Navigate');
  });

  it('calls a tool and returns its content', async () => {
    const h = harness([{ name: 'celeste_navigate', description: 'Navigate' }]);
    const res = await h.request('tools/call', {
      name: 'celeste_navigate',
      arguments: { url: 'https://example.com' },
    });
    const result = res.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('celeste_navigate');
    expect(result.content[0]?.text).toContain('https://example.com');
  });

  it('rejects an unknown tool', async () => {
    const h = harness();
    const res = await h.request('tools/call', { name: 'nope' });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32602);
  });

  it('rejects an unknown method', async () => {
    const h = harness();
    const res = await h.request('does/not/exist');
    expect(res.error?.code).toBe(-32601);
  });

  it('does not answer notifications', async () => {
    const h = harness();
    h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.responses).toHaveLength(0);
  });

  it('reports a parse error for malformed JSON', async () => {
    const h = harness();
    h.sendRaw('this is not json');
    await new Promise((r) => setTimeout(r, 150));
    const found = h.responses.find((r) => r.error?.code === -32700);
    expect(found).toBeDefined();
  });

  it('answers ping', async () => {
    const h = harness();
    const res = await h.request('ping');
    expect(res.error).toBeUndefined();
  });
});
