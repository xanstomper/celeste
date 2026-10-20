import type { Readable, Writable } from 'node:stream';

/** JSON-RPC 2.0 error codes used by MCP. */
export const JSONRPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export type McpToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

/**
 * A minimal but faithful Model Context Protocol server.
 *
 * MCP uses JSON-RPC 2.0 over a line-delimited stream. This implementation
 * speaks the stdio transport, which is what Claude Code, Cline and other
 * coding agents launch.
 */
export class McpServer {
  private readonly tools = new Map<string, McpToolHandler>();
  private readonly schemas = new Map<string, McpToolSchema>();
  private buffer = '';
  private readonly pending = new Map<string | number, (response: JsonRpcResponse) => void>();

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly serverInfo: { name: string; version: string },
  ) {}

  /** Registers a tool with its schema and handler. */
  registerTool(schema: McpToolSchema, handler: McpToolHandler): this {
    this.schemas.set(schema.name, schema);
    this.tools.set(schema.name, handler);
    return this;
  }

  /**
   * Starts serving.
   *
   * The input is consumed with a hand-rolled line splitter rather than
   * `readline`, because a client can legitimately write the `initialize`
   * request before this method runs — and `readline` can swallow bytes that
   * arrive while the stream is still paused. Owning the buffer means no
   * request is ever lost.
   */
  serve(): Promise<void> {
    const input = this.input as Readable & { setEncoding?: (e: BufferEncoding) => void };
    if (typeof input.setEncoding === 'function') input.setEncoding('utf8');

    let buffer = '';
    const onData = (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) void this.handleLine(line);
        index = buffer.indexOf('\n');
      }
    };

    input.on('data', onData);
    if (typeof input.resume === 'function') input.resume();

    return new Promise<void>((resolve) => {
      input.on('end', () => {
        // Flush a trailing line that arrived without a newline.
        const rest = buffer.trim();
        buffer = '';
        if (rest) void this.handleLine(rest);
        input.off('data', onData);
        resolve();
      });
      input.on('close', () => {
        input.off('data', onData);
        resolve();
      });
    });
  }

  private async handleLine(line: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.send({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSONRPC_ERRORS.parseError, message: 'Invalid JSON' },
      });
      return;
    }

    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      this.send({
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: JSONRPC_ERRORS.invalidRequest, message: 'Invalid request' },
      });
      return;
    }

    // Notifications have no id and expect no response.
    const isNotification = request.id === undefined || request.id === null;
    const result = await this.dispatch(request);

    if (isNotification) return;

    if ('error' in result) {
      this.send({ jsonrpc: '2.0', id: request.id ?? null, error: result.error });
    } else {
      this.send({ jsonrpc: '2.0', id: request.id ?? null, result: result.result });
    }
  }

  private async dispatch(
    request: JsonRpcRequest,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const params = (request.params ?? {}) as Record<string, unknown>;

    switch (request.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: this.serverInfo,
            instructions:
              'Celeste browser control. Use celeste_snapshot before clicking, and refer to elements by their ref. Celeste operates the user\'s real, logged-in browser.',
          },
        };

      case 'notifications/initialized':
      case 'initialized':
        return { result: {} };

      case 'ping':
        return { result: {} };

      case 'tools/list':
        return {
          result: {
            tools: [...this.schemas.values()],
          },
        };

      case 'tools/call': {
        const name = String(params.name ?? '');
        const handler = this.tools.get(name);
        if (!handler) {
          return {
            error: {
              code: JSONRPC_ERRORS.invalidParams,
              message: `Unknown tool "${name}"`,
            },
          };
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const output = await handler(args);
          return { result: output };
        } catch (err) {
          return {
            result: {
              content: [
                { type: 'text', text: err instanceof Error ? err.message : String(err) },
              ],
              isError: true,
            },
          };
        }
      }

      default:
        return {
          error: {
            code: JSONRPC_ERRORS.methodNotFound,
            message: `Method "${request.method}" not found`,
          },
        };
    }
  }

  private send(response: JsonRpcResponse): void {
    this.output.write(`${JSON.stringify(response)}\n`);
  }
}

/** Convenience helper for a text-only tool result. */
export function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

/** Convenience helper for an image tool result. */
export function imageResult(base64: string, mimeType = 'image/png'): McpToolResult {
  return { content: [{ type: 'image', data: base64, mimeType }] };
}
