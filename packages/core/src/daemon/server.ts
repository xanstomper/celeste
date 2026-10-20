import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { API_ROUTES } from '@celeste/protocol';
import type {
  ApprovalResponseRequest,
  CreateSessionRequest,
  DaemonEvent,
  ProviderSwitchRequest,
} from '@celeste/protocol';
import type { ModelGateway } from '@celeste/gateway';
import type { Agent } from '../agent/agent.js';
import type { ApprovalManager } from '../agent/approval.js';
import type { BrowserBridge } from '../browser/bridge.js';
import type { SessionGuard } from '../browser/session-guard.js';
import type { EventBus } from '../events.js';
import type { TaskStore } from '../store.js';

export interface DaemonOptions {
  port: number;
  host?: string;
  gateway: ModelGateway;
  store: TaskStore;
  bus: EventBus;
  agent: Agent;
  approvals: ApprovalManager;
  bridge: BrowserBridge;
  sessionGuard: SessionGuard;
  version?: string;
}

/**
 * The Celeste daemon's HTTP + WebSocket surface.
 *
 * Deliberately dependency-light: Node's own `http` server plus `ws` for the
 * live event stream. No framework, no middleware chain, no magic.
 */
export class Daemon {
  private readonly server = createServer();
  private wss: WebSocketServer | null = null;
  private readonly startedAt = Date.now();

  constructor(private readonly options: DaemonOptions) {
    this.server.on('request', (req, res) => {
      this.handle(req, res).catch((err) => {
        this.sendError(res, 500, 'INTERNAL', err instanceof Error ? err.message : String(err));
      });
    });
    // Keep a late server error (e.g. a socket failure) from taking the
    // process down as an unhandled 'error' event.
    this.server.on('error', (err) => {
      this.options.bus.publish({
        type: 'log',
        level: 'error',
        message: `Daemon server error: ${err instanceof Error ? err.message : String(err)}`,
        at: Date.now(),
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host ?? '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });

    // Live event stream for the UI.
    this.wss = new WebSocketServer({ server: this.server, path: API_ROUTES.websocket });
    this.wss.on('connection', (socket) => {
      const send = (event: DaemonEvent) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      };
      const unsubscribe = this.options.bus.subscribe(send);
      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);
    });
  }

  async stop(): Promise<void> {
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
      this.wss = null;
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /* ---------------------------------------------------------------------- */
  /* Routing                                                                */
  /* ---------------------------------------------------------------------- */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = url.pathname;
    const method = req.method ?? 'GET';

    // CORS — the UI may be served from a dev server on a different port.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    if (method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    try {
      if (route === API_ROUTES.health && method === 'GET') {
        return this.sendJson(res, 200, this.health());
      }

      if (route === API_ROUTES.providers && method === 'GET') {
        return this.sendJson(res, 200, { providers: this.providerSummaries() });
      }

      if (route === API_ROUTES.providerActive && method === 'POST') {
        const body = await readJson<ProviderSwitchRequest>(req);
        const cfg = this.options.gateway.setActiveProvider(body.id);
        this.options.bus.publish({
          type: 'provider.changed',
          providerId: cfg.id,
          model: cfg.model,
          at: Date.now(),
        });
        const active = this.providerSummaries().find((p) => p.id === cfg.id)!;
        return this.sendJson(res, 200, { active });
      }

      if (route === API_ROUTES.sessions && method === 'GET') {
        return this.sendJson(res, 200, { tasks: this.options.store.list() });
      }

      if (route === API_ROUTES.sessions && method === 'POST') {
        const body = await readJson<CreateSessionRequest>(req);
        return this.sendJson(res, 201, await this.createSession(body));
      }

      if (route === API_ROUTES.artifacts && method === 'GET') {
        const artifacts = this.options.store.list().flatMap((t) => t.artifacts);
        return this.sendJson(res, 200, { artifacts });
      }

      // /api/sessions/:id/...
      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(events|approve|cancel|message))?$/.exec(route);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]!);
        const action = sessionMatch[2];

        if (!action && method === 'GET') {
          const task = this.options.store.get(id);
          if (!task) return this.sendError(res, 404, 'NOT_FOUND', 'No such task.');
          return this.sendJson(res, 200, { task });
        }

        if (action === 'events' && method === 'GET') {
          return this.streamEvents(req, res, id);
        }

        if (action === 'approve' && method === 'POST') {
          const body = await readJson<ApprovalResponseRequest>(req);
          const okDecision = this.options.approvals.resolve(body.requestId, body.decision);
          if (!okDecision) {
            return this.sendError(res, 404, 'NOT_FOUND', 'No pending approval with that id.');
          }
          return this.sendJson(res, 200, { ok: true });
        }

        if (action === 'cancel' && method === 'POST') {
          const cancelled = this.options.agent.cancel(id);
          this.options.approvals.cancelAll();
          return this.sendJson(res, 200, { ok: cancelled });
        }

        if (action === 'message' && method === 'POST') {
          const body = (await readJson<{ content?: string }>(req)) ?? {};
          const content = String(body.content ?? '').trim();
          if (!content) return this.sendError(res, 400, 'INVALID_ARGS', 'content is required.');
          this.options.store.appendMessage(id, { role: 'user', content });
          this.options.bus.publish({
            type: 'task.message',
            taskId: id,
            message: { role: 'user', content },
            at: Date.now(),
          });
          return this.sendJson(res, 200, { ok: true });
        }
      }

      return this.sendError(res, 404, 'NOT_FOUND', `No route for ${method} ${route}`);
    } catch (err) {
      return this.sendError(res, 400, 'INVALID_ARGS', err instanceof Error ? err.message : String(err));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Session lifecycle                                                      */
  /* ---------------------------------------------------------------------- */

  private async createSession(body: CreateSessionRequest) {
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) throw new Error('A prompt is required.');

    const task = this.options.store.create(prompt.slice(0, 120));
    this.options.store.appendMessage(task.id, { role: 'user', content: prompt });
    this.options.bus.publish({
      type: 'task.created',
      taskId: task.id,
      title: task.title,
      at: Date.now(),
    });

    // Per-session overrides: a different provider, or a trusted auto-approve
    // mode for this task only.
    const overrides = {
      ...(body.providerId ? { providerId: body.providerId } : {}),
      ...(body.autoApprove !== undefined ? { autoApprove: body.autoApprove } : {}),
      ...(body.outputDir ? { outputDir: body.outputDir } : {}),
    };

    // Run the task in the background; the UI follows the event stream.
    void this.options.agent.run(task.id, overrides).catch((err) => {
      this.options.bus.publish({
        type: 'log',
        level: 'error',
        message: `Task ${task.id} crashed: ${err instanceof Error ? err.message : String(err)}`,
        at: Date.now(),
      });
    });

    return { task: this.options.store.get(task.id) ?? task };
  }

  /* ---------------------------------------------------------------------- */
  /* SSE stream                                                             */
  /* ---------------------------------------------------------------------- */

  private streamEvents(req: IncomingMessage, res: ServerResponse, taskId: string): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });

    const write = (event: DaemonEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Replay recent history so a late subscriber is not blind.
    const task = this.options.store.get(taskId);
    if (task) {
      for (const message of task.messages) {
        write({ type: 'task.message', taskId, message, at: Date.now() });
      }
      if (task.plan.length) {
        write({ type: 'task.plan', taskId, plan: task.plan, at: Date.now() });
      }
    }

    const unsubscribe = this.options.bus.onTask(taskId, write);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  private health() {
    const activeId = this.options.gateway.getActiveId();
    const active = this.options.gateway.listProviders().find((p) => p.id === activeId);
    return {
      ok: true,
      version: this.options.version ?? '0.1.0',
      apiVersion: '1.0.0',
      activeProvider: activeId,
      activeModel: active?.model,
      extensionConnected: this.options.bridge.isConnected,
      providerCount: this.options.gateway.listProviders().length,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  private providerSummaries() {
    const activeId = this.options.gateway.getActiveId();
    return this.options.gateway.listProviders().map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      model: p.model,
      baseUrl: p.baseUrl ?? null,
      active: p.id === activeId,
      hasKey: Boolean(p.apiKey || (p.apiKeyEnv && process.env[p.apiKeyEnv])),
      source: p.source,
    }));
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private sendError(
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
  ): void {
    this.sendJson(res, status, { error: message, code });
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('Request body is not valid JSON.');
  }
}
