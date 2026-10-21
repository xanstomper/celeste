import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { API_ROUTES, BROWSER_ACTIONS } from '@celeste/protocol';
import type {
  ApprovalResponseRequest,
  Attachment,
  ChatMessage,
  CreateSessionRequest,
  DaemonEvent,
  ProviderSwitchRequest,
} from '@celeste/protocol';
import { extractPdfText } from '@celeste/documents';
import type { ModelGateway } from '@celeste/gateway';
import type { Agent } from '../agent/agent.js';
import type { ApprovalManager } from '../agent/approval.js';
import type { BrowserBridge } from '../browser/bridge.js';
import type { SessionGuard } from '../browser/session-guard.js';
import type { EventBus } from '../events.js';
import type { TaskStore } from '../store.js';
import { FOLLOW_UP_SYSTEM_PROMPT } from '../agent/prompts.js';

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
  /** Whether to ask the model for follow-up questions after an answer. */
  suggestions?: boolean;
  version?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function findUiDist(): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
      const candidate = path.join(dir, 'packages', 'ui', 'dist');
      if (existsSync(path.join(candidate, 'index.html'))) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * The Celeste daemon's HTTP + WebSocket surface.
 *
 * Deliberately dependency-light: Node's own `http` server plus `ws` for the
 * live event stream. No framework, no middleware chain, no magic.
 */
/** Document types the agent can read as text. */
const READABLE_DOCUMENTS = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/html',
]);

function isReadableDocument(mimeType: string): boolean {
  return READABLE_DOCUMENTS.has(mimeType.toLowerCase().split(';')[0]!.trim());
}

/**
 * Turns attached documents into text parts.
 *
 * A PDF is the interesting one: the model cannot open a file, so the words
 * have to travel with the message. When a PDF cannot be read - a scan, an
 * exotic encoding - the model is told that instead of being left guessing.
 */
async function documentPartsFor(
  attachments: Attachment[],
): Promise<{ type: 'text'; text: string }[]> {
  const parts: { type: 'text'; text: string }[] = [];

  for (const attachment of attachments) {
    const mimeType = attachment.mimeType.toLowerCase().split(';')[0]!.trim();
    if (!isReadableDocument(mimeType)) continue;

    if (mimeType === 'application/pdf') {
      let text = '';
      let pages = 0;
      let readable = false;
      try {
        const extracted = extractPdfText(Buffer.from(attachment.data, 'base64'));
        text = extracted.text;
        pages = extracted.pages;
        readable = extracted.readable;
      } catch {
        readable = false;
      }
      parts.push({
        type: 'text',
        text: readable
          ? `Attached document: ${attachment.name} (${pages || '?'} pages)\n\n${text}`
          : `Attached document: ${attachment.name}. Its text could not be extracted (it may be a scan). Ask the user for the relevant part.`,
      });
      continue;
    }

    let text = '';
    try {
      text = Buffer.from(attachment.data, 'base64').toString('utf8');
    } catch {
      text = '';
    }
    parts.push({
      type: 'text',
      text: `Attached document: ${attachment.name}\n\n${text.slice(0, 60_000)}`,
    });
  }

  return parts;
}

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

    // Mirror browser actions into task store for persistence
    this.options.bus.subscribe((event) => {
      if (event.type === 'task.browser.action') {
        this.options.store.setBrowserAction?.(event.taskId, event.action);
      }
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

      if (route === API_ROUTES.browserStatus && method === 'GET') {
        const connected = this.options.bridge.isConnected;
        let activeTab: unknown = null;
        if (connected) {
          try {
            activeTab = await this.options.bridge.send('ping', {}, { timeoutMs: 3000 });
          } catch {
            /* ignore */
          }
        }
        return this.sendJson(res, 200, {
          connected,
          activeTab,
          info: this.options.bridge.info,
        });
      }

      if (route === API_ROUTES.browserViewport && method === 'POST') {
        // Start or stop the live viewport: a stream of frames of the page the
        // user is looking at, rather than a screenshot every few seconds.
        const body = (await readJson<{ action?: string }>(req)) ?? {};
        const action = body.action === 'stop' ? 'stop' : body.action === 'status' ? 'status' : 'start';
        try {
          const result = await this.options.bridge.send('viewport', { action }, { timeoutMs: 8000 });
          return this.sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return this.sendError(
            res,
            500,
            'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (route === API_ROUTES.browserScreenshot && method === 'GET') {
        if (!this.options.bridge.isConnected) {
          return this.sendError(res, 503, 'EXTENSION_DISCONNECTED', 'Browser extension is not connected.');
        }
        try {
          const shot = await this.options.bridge.send<{ data?: string; mimeType?: string }>(
            'screenshot',
            { format: 'jpeg' },
            { timeoutMs: 6000 },
          );
          return this.sendJson(res, 200, {
            data: shot?.data ?? null,
            mimeType: shot?.mimeType ?? 'image/jpeg',
          });
        } catch (err) {
          return this.sendError(res, 500, 'BROWSER_ERROR', err instanceof Error ? err.message : String(err));
        }
      }

      if (route === API_ROUTES.browserNavigate && method === 'POST') {
        if (!this.options.bridge.isConnected) {
          return this.sendError(res, 503, 'EXTENSION_DISCONNECTED', 'Browser extension is not connected.');
        }
        const body = (await readJson<{ url?: string }>(req)) ?? {};
        const url = String(body.url ?? '').trim();
        if (!url) return this.sendError(res, 400, 'INVALID_ARGS', 'url is required.');
        try {
          const nav = await this.options.bridge.send('navigate', { url }, { timeoutMs: 15000 });
          return this.sendJson(res, 200, { ok: true, result: nav });
        } catch (err) {
          return this.sendError(res, 500, 'BROWSER_ERROR', err instanceof Error ? err.message : String(err));
        }
      }

      if (route === API_ROUTES.browserSnapshot && (method === 'GET' || method === 'POST')) {
        if (!this.options.bridge.isConnected) {
          return this.sendError(res, 503, 'EXTENSION_DISCONNECTED', 'Browser extension is not connected.');
        }
        try {
          const snap = await this.options.bridge.send(
            'snapshot',
            { maxElements: 200, includeText: true },
            { timeoutMs: 8000 },
          );
          return this.sendJson(res, 200, { ok: true, snapshot: snap });
        } catch (err) {
          return this.sendError(res, 500, 'BROWSER_ERROR', err instanceof Error ? err.message : String(err));
        }
      }

      if (route === API_ROUTES.browserTabs && method === 'GET') {
        if (!this.options.bridge.isConnected) {
          return this.sendError(res, 503, 'EXTENSION_DISCONNECTED', 'Browser extension is not connected.');
        }
        try {
          const raw = await this.options.bridge.send<{ tabs?: unknown } | unknown[]>('tabs', { action: 'list' }, { timeoutMs: 5000 });
          // The extension returns { tabs: [...] }; older daemons accidentally
          // nested that object inside `tabs`. Flatten both shapes.
          const tabs = Array.isArray(raw) ? raw : (Array.isArray((raw as { tabs?: unknown })?.tabs) ? (raw as { tabs: unknown[] }).tabs : []);
          return this.sendJson(res, 200, { ok: true, tabs });
        } catch (err) {
          return this.sendError(res, 500, 'BROWSER_ERROR', err instanceof Error ? err.message : String(err));
        }
      }

      if (route === API_ROUTES.browserClick && method === 'POST') {
        const body = (await readJson<{ x?: number; y?: number; ref?: string }>(req)) ?? {};
        try {
          const clickRes = await this.options.bridge.send('click', body, { timeoutMs: 10000 });
          return this.sendJson(res, 200, { ok: true, result: clickRes });
        } catch (err) {
          return this.sendError(res, 500, 'BROWSER_ERROR', err instanceof Error ? err.message : String(err));
        }
      }

      if (route === API_ROUTES.browserType && method === 'POST') {
        const body = (await readJson<{ text?: string; ref?: string }>(req)) ?? {};
        try {
          const typeRes = await this.options.bridge.send('type', body, { timeoutMs: 10000 });
          return this.sendJson(res, 200, { ok: true, result: typeRes });
        } catch (err) {
          return this.sendError(res, 500, 'BROWSER_ERROR', err instanceof Error ? err.message : String(err));
        }
      }

      if (route === API_ROUTES.browserScroll && method === 'POST') {
        const body = (await readJson<{ deltaY?: number }>(req)) ?? {};
        try {
          const scrollRes = await this.options.bridge.send('scroll', body, { timeoutMs: 5000 });
          return this.sendJson(res, 200, { ok: true, result: scrollRes });
        } catch (err) {
          return this.sendError(res, 500, 'BROWSER_ERROR', err instanceof Error ? err.message : String(err));
        }
      }

      // Generic bridge passthrough. The extension implements many verbs
      // (press/fill/select/hover/evaluate/waitFor/...) that the UI never
      // needed bespoke routes for; local agents such as Mochi do. Keep the
      // allow-list to the protocol's browser verbs so this is not an
      // arbitrary bridge RPC.
      if (route === API_ROUTES.browserAction && method === 'POST') {
        if (!this.options.bridge.isConnected) {
          return this.sendError(res, 503, 'EXTENSION_DISCONNECTED', 'Browser extension is not connected.');
        }
        const body = (await readJson<{ action?: string; params?: Record<string, unknown>; timeoutMs?: number; tabId?: number }>(req)) ?? {};
        const action = String(body.action ?? '').trim();
        if (!BROWSER_ACTIONS.includes(action as never)) {
          return this.sendError(res, 400, 'INVALID_ARGS', `unsupported browser action: ${action || '(missing)'}`);
        }
        const timeoutMs = Math.min(60_000, Math.max(1_000, Number(body.timeoutMs) || 15_000));
        const tabId = Number.isFinite(Number(body.tabId)) ? Number(body.tabId) : undefined;
        try {
          const result = await this.options.bridge.send(action, body.params ?? {}, { timeoutMs, ...(tabId !== undefined ? { tabId } : {}) });
          return this.sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return this.sendError(res, 500, 'BROWSER_ERROR', err instanceof Error ? err.message : String(err));
        }
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
          const body =
            (await readJson<{
              content?: string;
              providerId?: string;
              autoApprove?: boolean;
              attachments?: Attachment[];
            }>(req)) ?? {};
          const rawContent = String(body.content ?? '').trim();
          const attachments = (body.attachments ?? [])
            .filter(
              (a) =>
                a &&
                typeof a.data === 'string' &&
                a.data.length > 0 &&
                typeof a.mimeType === 'string' &&
                a.mimeType.startsWith('image/'),
            )
            .slice(0, 6);
          if (!rawContent && attachments.length === 0) {
            return this.sendError(res, 400, 'INVALID_ARGS', 'content is required.');
          }

          const existing = this.options.store.get(id);
          if (!existing) return this.sendError(res, 404, 'NOT_FOUND', `No session ${id}.`);

          const content = rawContent || 'Describe this image.';
          const messageContent: ChatMessage['content'] =
            attachments.length > 0
              ? [
                  { type: 'text' as const, text: content },
                  ...attachments.map((a) => ({
                    type: 'image' as const,
                    data: a.data,
                    mimeType: a.mimeType,
                  })),
                ]
              : content;

          this.options.store.appendMessage(id, { role: 'user', content: messageContent });
          this.options.bus.publish({
            type: 'task.message',
            taskId: id,
            message: { role: 'user', content: messageContent },
            at: Date.now(),
          });

          // A follow-up is a new turn on the same thread: the agent reads the
          // conversation so far and answers in context. Without this the
          // message would just sit in the transcript unanswered.
          const overrides = {
            ...(body.providerId ? { providerId: body.providerId } : {}),
            autoApprove: body.autoApprove !== undefined ? body.autoApprove : true,
          };
          void this.options.agent
            .run(id, overrides)
            .then(() => this.suggestFollowUps(id, overrides.providerId))
            .catch((err) => {
              this.options.bus.publish({
                type: 'log',
                level: 'error',
                message: `Session ${id} crashed: ${err instanceof Error ? err.message : String(err)}`,
                at: Date.now(),
              });
            });

          return this.sendJson(res, 200, { ok: true });
        }
      }

      // Serve static web UI files when requesting any non-API route
      if ((method === 'GET' || method === 'HEAD') && !route.startsWith('/api') && route !== API_ROUTES.websocket) {
        const handled = await this.serveStatic(req, res, route);
        if (handled) return;
      }

      return this.sendError(res, 404, 'NOT_FOUND', `No route for ${method} ${route}`);
    } catch (err) {
      return this.sendError(res, 400, 'INVALID_ARGS', err instanceof Error ? err.message : String(err));
    }
  }

  private async serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const uiDist = findUiDist();
    if (!uiDist) return false;

    try {
      const decoded = decodeURIComponent(pathname);
      const cleanPath = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
      let target = path.join(uiDist, cleanPath);

      if (cleanPath === '/' || cleanPath === '' || cleanPath === '.') {
        target = path.join(uiDist, 'index.html');
      }

      if (!existsSync(target) || !statSync(target).isFile()) {
        target = path.join(uiDist, 'index.html');
        if (!existsSync(target)) return false;
      }

      const ext = path.extname(target).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

      res.statusCode = 200;
      res.setHeader('content-type', contentType);
      if (ext === '.html') {
        res.setHeader('cache-control', 'no-cache');
      } else {
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      }

      if (req.method === 'HEAD') {
        res.end();
        return true;
      }

      createReadStream(target).pipe(res);
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Session lifecycle                                                      */
  /* ---------------------------------------------------------------------- */

  private async createSession(body: CreateSessionRequest) {
    const rawPrompt = String(body.prompt ?? '').trim();

    // Attachments ride along as content parts: images stay images, and
    // documents are read so the model gets the words rather than a file it
    // cannot open.
    const attachments = (body.attachments ?? [])
      .filter(
        (a) =>
          a &&
          typeof a.data === 'string' &&
          a.data.length > 0 &&
          typeof a.mimeType === 'string' &&
          (a.mimeType.startsWith('image/') || isReadableDocument(a.mimeType)),
      )
      .slice(0, 6);
    if (!rawPrompt && attachments.length === 0) throw new Error('A prompt is required.');

    const prompt = rawPrompt || 'Describe this image.';

    // Turn documents into text the model can actually read.
    const documentParts = await documentPartsFor(attachments);

    // Only the modes we know how to research; anything else is the open web.
    const focus = body.focus === 'academic' || body.focus === 'news' ? body.focus : undefined;
    const depth = body.depth === 'research' ? 'research' : undefined;
    const task = this.options.store.create(prompt.slice(0, 120), focus, depth);
    this.options.store.appendMessage(task.id, {
      role: 'user',
      content:
        attachments.length > 0
          ? [
              { type: 'text' as const, text: prompt },
              ...attachments.map((a) => ({
                type: 'image' as const,
                data: a.data,
                mimeType: a.mimeType,
              })),
              ...documentParts,
            ]
          : prompt,
    });
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
      autoApprove: body.autoApprove !== undefined ? body.autoApprove : true,
      ...(body.outputDir ? { outputDir: body.outputDir } : {}),
    };

    // Run the task in the background; the UI follows the event stream.
    void this.options.agent
      .run(task.id, overrides)
      .then(() => this.suggestFollowUps(task.id, overrides.providerId))
      .catch((err) => {
        this.options.bus.publish({
          type: 'log',
          level: 'error',
          message: `Task ${task.id} crashed: ${err instanceof Error ? err.message : String(err)}`,
          at: Date.now(),
        });
      });

    return { task: this.options.store.get(task.id) ?? task };
  }

  /**
   * Offers follow-up questions once an answer is ready.
   *
   * Best effort by design: if the model is busy, unavailable, or returns
   * something unusable, the answer simply arrives without suggestions. A
   * nicety must never turn into a failed task.
   */
  private async suggestFollowUps(taskId: string, providerId?: string): Promise<void> {
    try {
      const task = this.options.store.get(taskId);
      if (!task || task.status !== 'completed') return;

      const answer = [...task.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' &&
            messageText(message).trim().length > 40 &&
            !message.toolCalls?.length,
        );
      const question = task.messages.find((message) => message.role === 'user');
      if (!answer || !question) return;

      const response = await this.options.gateway.chat(
        {
          messages: [
            { role: 'system', content: FOLLOW_UP_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Question: ${messageText(question).slice(0, 1200)}

Answer:
${messageText(answer).slice(0, 4000)}`,
            },
          ],
          temperature: 0.5,
          maxTokens: 220,
          toolChoice: 'none',
        },
        providerId,
      );

      const suggestions = parseSuggestions(response.message);
      if (suggestions.length === 0) return;

      this.options.store.update(taskId, (state) => {
        state.suggestions = suggestions;
      });
      this.options.bus.publish({
        type: 'task.suggestions',
        taskId,
        suggestions,
        at: Date.now(),
      });
    } catch (err) {
      // A nicety, never a failure: report it and move on.
      this.options.bus.publish({
        type: 'log',
        level: 'warn',
        message: `Could not suggest follow-ups: ${err instanceof Error ? err.message : String(err)}`,
        at: Date.now(),
      });
    }
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
      supportsVision: p.supportsVision,
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

/** The plain text of a chat message, whatever shape its content is in. */
function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

/** Pulls up to three question-shaped lines out of a model reply. */
const QUESTION_START =
  /^(?:what|why|how|when|where|who|which|whose|can|could|does|did|is|are|was|were|should|would|will|has|have)\b/i;

/**
 * Pulls three follow-up questions out of whatever the model produced.
 *
 * Models answer this prompt in three different shapes: a bare list, a JSON
 * array, or sentences that are questions without the question mark. All three
 * are accepted — a missing "?" is a typographic detail, not a reason to show
 * the reader nothing.
 */
export function parseSuggestions(message: ChatMessage): string[] {
  const raw = messageText(message).trim();

  // Some models wrap the list in JSON despite being asked not to.
  const json = /\[[\s\S]*\]/.exec(raw);
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json[0]);
      if (Array.isArray(parsed)) {
        const questions = parsed
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length >= 12 && item.length <= 160)
          .map((item) => (item.endsWith('?') ? item : `${item}?`))
          .slice(0, 3);
        if (questions.length > 0) return questions;
      }
    } catch {
      // Not JSON after all; fall through to the line parser.
    }
  }

  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .map((line) => line.replace(/^["'“”]+|["'“”]+$/g, '').trim())
    .filter((line) => line.length >= 12 && line.length <= 160)
    .map((line) => (line.endsWith('?') ? line : QUESTION_START.test(line) ? `${line}?` : line))
    .filter((line) => line.includes('?'))
    .slice(0, 3);
}
