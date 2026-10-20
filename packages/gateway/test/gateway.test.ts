import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { OpenAiCompatibleProvider } from '../src/providers/openai.js';
import { GoogleProvider } from '../src/providers/google.js';
import { ModelGateway } from '../src/gateway.js';
import { loadConfig, discoverEnvProviders } from '../src/config.js';
import type { ProviderConfig } from '../src/types.js';

/** A tiny HTTP server that records the request it received and replies. */
function mockApi(response: unknown, status = 200) {
  const received: Array<{ url: string; body: unknown; headers: Record<string, unknown> }> = [];
  let server: Server;

  const ready = new Promise<{ port: number }>((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = raw;
        }
        received.push({ url: req.url ?? '', body, headers: req.headers });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port });
    });
  });

  return {
    ready,
    received,
    get baseUrl() {
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('OpenAiCompatibleProvider', () => {
  it('normalises a tool-calling response', async () => {
    const api = mockApi({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'I will open it.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'browser_navigate', arguments: '{"url":"https://example.com"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const { port } = await api.ready;

    const provider = new OpenAiCompatibleProvider({
      id: 'mock',
      kind: 'openai-compatible',
      label: 'Mock',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'mock-model',
      apiKey: 'secret',
    });

    const res = await provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'browser_navigate',
          description: 'Navigate',
          parameters: { type: 'object', properties: { url: { type: 'string' } } },
          runtime: 'browser',
          requiresApproval: false,
        },
      ],
    });

    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]?.name).toBe('browser_navigate');
    expect(res.toolCalls[0]?.arguments).toEqual({ url: 'https://example.com' });
    expect(res.message.role).toBe('assistant');
    expect(res.usage?.totalTokens).toBe(15);

    // The request should carry the auth header and the tool definitions.
    const sent = api.received[0];
    expect(sent?.headers.authorization).toBe('Bearer secret');
    expect(sent?.url).toBe('/v1/chat/completions');
    const body = sent?.body as { tools: Array<{ function: { name: string } }> };
    expect(body.tools[0]?.function.name).toBe('browser_navigate');

    await api.close();
  });

  it('surfaces a provider error with the right retryability', async () => {
    const api = mockApi({ error: { message: 'rate limited' } }, 429);
    const { port } = await api.ready;

    const provider = new OpenAiCompatibleProvider({
      id: 'mock',
      kind: 'openai-compatible',
      label: 'Mock',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'mock-model',
      apiKey: 'k',
    });

    await expect(provider.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /429/,
    );
    await api.close();
  });

  it('tolerates a malformed arguments blob', async () => {
    const api = mockApi({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: 'not json' } }],
          },
        },
      ],
    });
    const { port } = await api.ready;

    const provider = new OpenAiCompatibleProvider({
      id: 'mock',
      kind: 'openai-compatible',
      label: 'Mock',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'm',
    });
    const res = await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(res.toolCalls[0]?.arguments).toEqual({ __raw: 'not json' });
    await api.close();
  });
});

describe('AnthropicProvider', () => {
  it('maps tool_use blocks onto tool calls', async () => {
    const api = mockApi({
      content: [
        { type: 'thinking', thinking: 'Let me think.' },
        { type: 'text', text: 'Opening the page.' },
        { type: 'tool_use', id: 'tu_1', name: 'browser_navigate', input: { url: 'https://x.dev' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 8 },
    });
    const { port } = await api.ready;

    const provider = new AnthropicProvider({
      id: 'mock',
      kind: 'anthropic',
      label: 'Mock',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'claude-x',
      apiKey: 'sk-test',
    });

    const res = await provider.chat({
      messages: [
        { role: 'system', content: 'be careful' },
        { role: 'user', content: 'go' },
      ],
      tools: [
        {
          name: 'browser_navigate',
          description: 'Navigate',
          parameters: { type: 'object', properties: {} },
          runtime: 'browser',
          requiresApproval: false,
        },
      ],
    });

    expect(res.toolCalls[0]?.name).toBe('browser_navigate');
    expect(res.toolCalls[0]?.arguments).toEqual({ url: 'https://x.dev' });
    expect(res.message.content).toContain('Opening the page.');

    const sent = api.received[0];
    expect(sent?.headers['x-api-key']).toBe('sk-test');
    expect(sent?.headers['anthropic-version']).toBe('2023-06-01');
    const body = sent?.body as { system?: string; tools?: unknown[] };
    expect(body.system).toBe('be careful');
    expect(body.tools).toHaveLength(1);

    await api.close();
  });
});

describe('OllamaProvider', () => {
  it('sends tools and reads back local tool calls', async () => {
    const api = mockApi({
      message: {
        role: 'assistant',
        content: 'Thinking locally.',
        tool_calls: [{ function: { name: 'file_list', arguments: { path: '/tmp' } } }],
      },
      done_reason: 'stop',
      prompt_eval_count: 5,
      eval_count: 3,
    });
    const { port } = await api.ready;

    const provider = new OllamaProvider({
      id: 'ollama',
      kind: 'ollama',
      label: 'Ollama',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'qwen2.5:7b',
    });

    const res = await provider.chat({
      messages: [{ role: 'user', content: 'list files' }],
      tools: [
        {
          name: 'file_list',
          description: 'List',
          parameters: { type: 'object', properties: {} },
          runtime: 'local',
          requiresApproval: false,
        },
      ],
    });

    expect(res.toolCalls[0]?.name).toBe('file_list');
    expect(res.toolCalls[0]?.arguments).toEqual({ path: '/tmp' });
    expect(api.received[0]?.url).toBe('/api/chat');

    await api.close();
  });
});

describe('GoogleProvider', () => {
  it('maps functionCall parts onto tool calls', async () => {
    const api = mockApi({
      candidates: [
        {
          content: {
            parts: [{ text: 'Looking it up.' }, { functionCall: { name: 'browser_extract', args: {} } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
    });
    const { port } = await api.ready;

    const provider = new GoogleProvider({
      id: 'gemini',
      kind: 'google',
      label: 'Gemini',
      baseUrl: `http://127.0.0.1:${port}/v1beta`,
      model: 'gemini-x',
      apiKey: 'g-key',
    });

    const res = await provider.chat({
      messages: [{ role: 'user', content: 'extract' }],
      tools: [
        {
          name: 'browser_extract',
          description: 'Extract',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          runtime: 'browser',
          requiresApproval: false,
        },
      ],
    });

    expect(res.toolCalls[0]?.name).toBe('browser_extract');
    expect(res.usage?.totalTokens).toBe(13);
    expect(api.received[0]?.url).toContain('gemini-x:generateContent');

    await api.close();
  });
});

describe('ModelGateway', () => {
  it('switches the active provider without recreating it', () => {
    const gateway = new ModelGateway([
      { id: 'a', kind: 'openai-compatible', label: 'A', model: 'a-model' },
      { id: 'b', kind: 'openai-compatible', label: 'B', model: 'b-model' },
    ]);

    expect(gateway.getActiveId()).toBeUndefined();
    gateway.setActiveProvider('a');
    expect(gateway.getActiveId()).toBe('a');

    const first = gateway.getProvider();
    gateway.setActiveProvider('b');
    expect(gateway.getActiveId()).toBe('b');
    expect(gateway.getProvider()).not.toBe(first);
  });

  it('rejects an unknown provider id', () => {
    const gateway = new ModelGateway([
      { id: 'a', kind: 'openai-compatible', label: 'A', model: 'a-model' },
    ]);
    expect(() => gateway.setActiveProvider('nope')).toThrow(/Unknown provider/);
  });

  it('reports health for every provider', async () => {
    const api = mockApi({ data: [] });
    const { port } = await api.ready;

    const gateway = new ModelGateway([
      {
        id: 'a',
        kind: 'openai-compatible',
        label: 'A',
        model: 'a-model',
        baseUrl: `http://127.0.0.1:${port}/v1`,
      },
      {
        id: 'dead',
        kind: 'openai-compatible',
        label: 'Dead',
        model: 'd-model',
        baseUrl: 'http://127.0.0.1:1/v1',
      },
    ]);

    const health = await gateway.healthAll();
    expect(health).toHaveLength(2);
    const alive = health.find((h) => h.id === 'a');
    const dead = health.find((h) => h.id === 'dead');
    expect(alive?.reachable).toBe(true);
    expect(dead?.reachable).toBe(false);

    await api.close();
  });
});

describe('config', () => {
  it('always includes the built-in providers', async () => {
    const config = await loadConfig('/nonexistent/path.json');
    const ids = config.providers.map((p) => p.id);
    expect(ids).toContain('ollama');
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openrouter');
  });

  it('picks an active provider', async () => {
    const config = await loadConfig('/nonexistent/path.json');
    expect(config.activeProvider).toBeTruthy();
  });

  it('discovers providers from environment keys', () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    try {
      const found = discoverEnvProviders();
      const openrouter = found.find((p) => p.id === 'openrouter');
      expect(openrouter).toBeDefined();
      expect(openrouter?.baseUrl).toContain('openrouter.ai');
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });
});
