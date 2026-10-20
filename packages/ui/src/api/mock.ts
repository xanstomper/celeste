/**
 * In-browser mock of the Celeste daemon.
 *
 * The desktop client must never render a broken screen, so when the real
 * daemon cannot be reached the UI swaps to this transport. It implements the
 * exact same {@link DaemonTransport} contract and replays a realistic
 * `DaemonEvent` stream: plan growth, tool start/end pairs with plausible
 * durations, artifact drops, an approval gate that actually blocks until the
 * user decides, and a human-intervention banner.
 */

import type {
  ApprovalRequest,
  Artifact,
  ChatMessage,
  DaemonEvent,
  HealthResponse,
  PlanStep,
  ProviderSummary,
  TaskState,
  TaskStatus,
} from '@celeste/protocol';

import type { DaemonTransport } from './client';
import { applyEventToTask } from '../state/timeline';

interface PendingApproval {
  request: ApprovalRequest;
  settle: (decision: 'approve' | 'deny') => void;
}

interface MockSession {
  id: string;
  task: TaskState;
  events: DaemonEvent[];
  cancelled: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  wakeups: Set<() => void>;
  pendingApproval: PendingApproval | null;
}

type Listener = (event: DaemonEvent) => void;

const MOCK_VERSION = '0.1.0';
const MOCK_API_VERSION = '1.0.0';

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function mockTask(id: string, title: string, status: TaskStatus, createdAt: number): TaskState {
  return {
    id,
    title,
    status,
    plan: [],
    messages: [],
    scratch: {},
    artifacts: [],
    createdAt,
    updatedAt: createdAt,
  };
}

/** Returns a copy of the plan with a single step moved to a new status. */
function withStepStatus(steps: PlanStep[], index: number, status: PlanStep['status']): PlanStep[] {
  return steps.map((step, i) => (i === index ? { ...step, status } : step));
}

const MOCK_PROVIDERS: ProviderSummary[] = [
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    kind: 'openai-compatible',
    model: 'deepseek-v4-flash-free',
    baseUrl: 'https://opencode.ai/zen/v1',
    active: true,
    hasKey: true,
    source: 'env',
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    kind: 'openai-compatible',
    model: 'gpt-5.4-nano',
    baseUrl: 'https://opencode.ai/go/v1',
    active: false,
    hasKey: true,
    source: 'env',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    model: 'claude-sonnet-4-5',
    baseUrl: 'https://api.anthropic.com/v1',
    active: false,
    hasKey: false,
    source: 'none',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'ollama',
    model: 'qwen3:8b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    active: false,
    hasKey: true,
    source: 'builtin',
  },
];

export class MockTransport implements DaemonTransport {
  readonly kind = 'mock' as const;

  private readonly sessions = new Map<string, MockSession>();
  private readonly sessionListeners = new Map<string, Set<Listener>>();
  private readonly globalListeners = new Set<Listener>();
  private providers: ProviderSummary[] = MOCK_PROVIDERS.map((p) => ({ ...p }));
  private startedAt = Date.now();
  private disposed = false;

  constructor() {
    this.seed();
  }

  /* ---------------------------------------------------------------------- */
  /* Transport contract                                                      */
  /* ---------------------------------------------------------------------- */

  async health(): Promise<HealthResponse> {
    await this.delay(60);
    const active = this.providers.find((p) => p.active);
    return {
      ok: true,
      version: MOCK_VERSION,
      apiVersion: MOCK_API_VERSION,
      activeProvider: active?.id,
      activeModel: active?.model,
      extensionConnected: true,
      providerCount: this.providers.length,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  async listProviders(): Promise<ProviderSummary[]> {
    await this.delay(60);
    return this.providers.map((p) => ({ ...p }));
  }

  async switchProvider(id: string): Promise<ProviderSummary> {
    await this.delay(180);
    const target = this.providers.find((p) => p.id === id);
    if (!target) throw new Error(`Unknown provider: ${id}`);
    this.providers = this.providers.map((p) => ({ ...p, active: p.id === id }));
    this.emitGlobal({ type: 'provider.changed', providerId: target.id, model: target.model, at: Date.now() });
    return { ...target, active: true };
  }

  async listSessions(): Promise<TaskState[]> {
    await this.delay(60);
    return [...this.sessions.values()]
      .map((s) => ({ ...s.task }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createSession(request: {
    prompt: string;
    providerId?: string;
    autoApprove?: boolean;
    outputDir?: string;
  }): Promise<TaskState> {
    await this.delay(120);
    const now = Date.now();
    const id = nextId('task');
    const title = request.prompt.trim().slice(0, 72) || 'New task';
    const session: MockSession = {
      id,
      task: mockTask(id, title, 'queued', now),
      events: [],
      cancelled: false,
      timers: new Set(),
      wakeups: new Set(),
      pendingApproval: null,
    };
    this.sessions.set(id, session);
    this.emit(session, {
      type: 'task.created',
      taskId: id,
      title,
      at: now,
    });
    // A real daemon echoes the prompt back as a user message.
    this.emit(session, {
      type: 'task.message',
      taskId: id,
      message: { role: 'user', content: request.prompt },
      at: now + 1,
    });
    void this.runNewTask(session, request.prompt, request.autoApprove === true);
    return { ...session.task };
  }

  async getSession(id: string): Promise<TaskState> {
    await this.delay(40);
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return { ...session.task };
  }

  async approve(id: string, body: { requestId: string; decision: 'approve' | 'deny' }): Promise<void> {
    await this.delay(120);
    const session = this.sessions.get(id);
    const pending = session?.pendingApproval;
    if (!session || !pending || pending.request.id !== body.requestId) {
      // The mock keeps the UI honest: answering a stale approval is a no-op.
      return;
    }
    pending.settle(body.decision);
  }

  async cancel(id: string): Promise<void> {
    await this.delay(80);
    const session = this.sessions.get(id);
    if (!session) return;
    session.cancelled = true;
    this.releaseTimers(session);
    this.emit(session, {
      type: 'task.done',
      taskId: id,
      status: 'cancelled',
      at: Date.now(),
    });
  }

  async sendMessage(id: string, content: string): Promise<void> {
    await this.delay(80);
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    const message: ChatMessage = { role: 'user', content };
    this.emit(session, { type: 'task.message', taskId: id, message, at: Date.now() });
    void this.runFollowUp(session, content);
  }

  async listArtifacts(): Promise<Artifact[]> {
    await this.delay(60);
    const artifacts: Artifact[] = [];
    for (const session of this.sessions.values()) artifacts.push(...session.task.artifacts);
    return artifacts.sort((a, b) => b.createdAt - a.createdAt);
  }

  subscribe(sessionId: string, onEvent: Listener): () => void {
    let set = this.sessionListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionListeners.set(sessionId, set);
    }
    set.add(onEvent);

    // Replay the recorded history so a session that was seeded (or has been
    // running in the background) shows its full transcript when selected.
    const session = this.sessions.get(sessionId);
    if (session) {
      for (const event of session.events) onEvent(event);
    }

    return () => {
      set?.delete(onEvent);
    };
  }

  subscribeGlobal(onEvent: Listener): () => void {
    this.globalListeners.add(onEvent);
    return () => {
      this.globalListeners.delete(onEvent);
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) this.releaseTimers(session);
    this.globalListeners.clear();
    this.sessionListeners.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Plumbing                                                                */
  /* ---------------------------------------------------------------------- */

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private sleep(session: MockSession, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (session.cancelled || this.disposed) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        session.timers.delete(timer);
        session.wakeups.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      session.timers.add(timer);
      session.wakeups.add(finish);
    });
  }

  private releaseTimers(session: MockSession): void {
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    for (const wake of session.wakeups) wake();
    session.wakeups.clear();
  }

  private emit(session: MockSession, event: DaemonEvent): void {
    if (this.disposed) return;
    session.events.push(event);
    session.task = applyEventToTask(session.task, event);
    const listeners = this.sessionListeners.get(session.id);
    if (listeners) for (const listener of listeners) listener(event);
    for (const listener of this.globalListeners) listener(event);
  }

  private emitGlobal(event: DaemonEvent): void {
    if (this.disposed) return;
    for (const listener of this.globalListeners) listener(event);
  }

  /* ---------------------------------------------------------------------- */
  /* Scenario helpers                                                        */
  /* ---------------------------------------------------------------------- */

  private async tool(
    session: MockSession,
    toolName: string,
    args: Record<string, unknown>,
    summary: string,
    durationMs: number,
    data?: unknown,
    error?: { code: string; message: string },
  ): Promise<void> {
    const callId = nextId('call');
    this.emit(session, {
      type: 'task.tool.start',
      taskId: session.id,
      callId,
      toolName,
      arguments: args,
      at: Date.now(),
    });
    await this.sleep(session, Math.min(durationMs, 1500));
    if (session.cancelled) return;
    this.emit(session, {
      type: 'task.tool.end',
      taskId: session.id,
      callId,
      toolName,
      ok: !error,
      summary,
      durationMs,
      data,
      error,
      at: Date.now(),
    });
  }

  private async requestApproval(
    session: MockSession,
    toolName: string,
    args: Record<string, unknown>,
    reason: string,
    risk: ApprovalRequest['risk'],
  ): Promise<'approve' | 'deny'> {
    const request: ApprovalRequest = {
      id: nextId('apr'),
      taskId: session.id,
      toolName,
      arguments: args,
      reason,
      risk,
      createdAt: Date.now(),
    };
    this.emit(session, { type: 'task.approval', taskId: session.id, request, at: Date.now() });
    this.emit(session, {
      type: 'task.status',
      taskId: session.id,
      status: 'awaiting_approval',
      at: Date.now(),
    });
    const decision = await new Promise<'approve' | 'deny'>((resolve) => {
      session.pendingApproval = { request, settle: resolve };
    });
    session.pendingApproval = null;
    this.emit(session, {
      type: 'task.status',
      taskId: session.id,
      status: 'running',
      at: Date.now(),
    });
    return decision;
  }

  /* ---------------------------------------------------------------------- */
  /* Scenarios                                                               */
  /* ---------------------------------------------------------------------- */

  private async runNewTask(
    session: MockSession,
    prompt: string,
    autoApprove: boolean,
  ): Promise<void> {
    let steps: PlanStep[] = [
      {
        id: 'step-1',
        description: 'Open the target page and capture an accessibility snapshot',
        status: 'active',
      },
      { id: 'step-2', description: 'Extract the relevant content into structured data', status: 'pending' },
      { id: 'step-3', description: 'Write the deliverable into the output directory', status: 'pending' },
      { id: 'step-4', description: 'Verify the result and summarise what changed', status: 'pending' },
    ];

    await this.sleep(session, 420);
    if (session.cancelled) return;
    this.emit(session, { type: 'task.status', taskId: session.id, status: 'running', at: Date.now() });
    this.emit(session, { type: 'task.plan', taskId: session.id, plan: steps, at: Date.now() });

    await this.sleep(session, 520);
    this.emit(session, {
      type: 'task.message',
      taskId: session.id,
      message: {
        role: 'assistant',
        content: `On it — “${prompt.trim().slice(0, 120)}”. I’ll read the page structure first, then only act once I know exactly what I’m touching.`,
        name: 'deepseek-v4-flash-free',
      },
      at: Date.now(),
    });

    await this.sleep(session, 260);
    await this.tool(
      session,
      'browser_navigate',
      { url: 'https://linear.app/pricing', waitUntil: 'networkidle' },
      'Loaded linear.app/pricing (200)',
      820,
      { url: 'https://linear.app/pricing', title: 'Pricing – Linear', status: 200 },
    );

    await this.sleep(session, 240);
    await this.tool(
      session,
      'browser_snapshot',
      { includeHidden: false, maxDepth: 12 },
      'Captured 63 interactive elements',
      560,
      { url: 'https://linear.app/pricing', title: 'Pricing – Linear', elements: 63 },
    );

    await this.sleep(session, 220);
    await this.tool(
      session,
      'browser_click',
      { ref: 'e27', label: 'Compare plans', waitForNavigation: false },
      'Clicked "Compare plans" (e27)',
      340,
      { ref: 'e27', navigated: false },
    );

    await this.sleep(session, 200);
    this.emit(session, {
      type: 'task.human',
      taskId: session.id,
      reason:
        'The pricing page asks for a phone number before showing the comparison table. Only you can enter it — I will keep going with the free tier meanwhile.',
      at: Date.now(),
    });

    steps = withStepStatus(steps, 0, 'done');
    steps = withStepStatus(steps, 1, 'active');
    this.emit(session, { type: 'task.plan', taskId: session.id, plan: [...steps], at: Date.now() });

    await this.sleep(session, 300);
    await this.tool(
      session,
      'browser_extract',
      { selector: 'main', format: 'markdown', includeLinks: true },
      'Extracted 3 sections, 12 links',
      700,
      { sections: 3, links: 12, characters: 8412 },
    );

    await this.sleep(session, 280);
    await this.tool(
      session,
      'celeste_mcp_call',
      { server: 'filesystem', tool: 'read_notes', arguments: { file: 'pricing-notes.md' } },
      'MCP filesystem.read_notes returned 1.2 KB',
      430,
      { server: 'filesystem', bytes: 1240 },
    );

    steps = withStepStatus(steps, 1, 'done');
    steps = withStepStatus(steps, 2, 'active');
    this.emit(session, { type: 'task.plan', taskId: session.id, plan: [...steps], at: Date.now() });

    await this.sleep(session, 320);
    const artifact: Artifact = {
      path: '~/celeste-output/pricing-brief.md',
      kind: 'md',
      bytes: 18_432,
      createdAt: Date.now(),
      description: 'Pricing research brief with a comparison table',
    };
    await this.tool(
      session,
      'document_create',
      { format: 'docx', title: 'Pricing Brief', path: '~/celeste-output/pricing-brief.md' },
      'Wrote pricing-brief.md (18 KB)',
      900,
      { path: artifact.path, bytes: artifact.bytes },
    );
    this.emit(session, { type: 'task.artifact', taskId: session.id, artifact, at: Date.now() });

    steps = withStepStatus(steps, 2, 'done');
    steps = withStepStatus(steps, 3, 'active');
    this.emit(session, { type: 'task.plan', taskId: session.id, plan: [...steps], at: Date.now() });

    await this.sleep(session, 300);
    this.emit(session, {
      type: 'task.message',
      taskId: session.id,
      message: {
        role: 'assistant',
        content:
          'The brief is written. One last thing needs your sign-off: submitting the contact form sends your details to a third party and cannot be undone.',
        name: 'deepseek-v4-flash-free',
      },
      at: Date.now(),
    });

    const decision = autoApprove
      ? 'approve'
      : await this.requestApproval(
          session,
          'browser_submit_form',
          {
            selector: '#contact-form',
            fields: { email: 'demo@localhost', message: 'Interested in the Team plan' },
          },
          'Submitting a form transmits data to an external service. This action cannot be undone.',
          'high',
        );

    if (session.cancelled) return;

    const callId = nextId('call');
    this.emit(session, {
      type: 'task.tool.start',
      taskId: session.id,
      callId,
      toolName: 'browser_submit_form',
      arguments: {
        selector: '#contact-form',
        fields: { email: 'demo@localhost', message: 'Interested in the Team plan' },
      },
      at: Date.now(),
    });
    await this.sleep(session, 640);
    if (session.cancelled) return;

    if (decision === 'approve') {
      this.emit(session, {
        type: 'task.tool.end',
        taskId: session.id,
        callId,
        toolName: 'browser_submit_form',
        ok: true,
        summary: 'Form submitted successfully',
        durationMs: 640,
        data: { ok: true, redirect: '/thanks' },
        at: Date.now(),
      });
    } else {
      this.emit(session, {
        type: 'task.tool.end',
        taskId: session.id,
        callId,
        toolName: 'browser_submit_form',
        ok: false,
        summary: 'Denied by the operator',
        durationMs: 640,
        error: { code: 'PERMISSION_DENIED', message: 'The operator denied this action.' },
        at: Date.now(),
      });
    }

    steps = withStepStatus(steps, 3, decision === 'approve' ? 'done' : 'skipped');
    this.emit(session, { type: 'task.plan', taskId: session.id, plan: [...steps], at: Date.now() });

    await this.sleep(session, 320);
    this.emit(session, {
      type: 'task.message',
      taskId: session.id,
      message: {
        role: 'assistant',
        content:
          decision === 'approve'
            ? 'All done — brief written and the form submitted. Say the word if you want me to change the tone.'
            : 'Understood, I skipped the form submission. The brief is still written to your output directory.',
        name: 'deepseek-v4-flash-free',
      },
      at: Date.now(),
    });

    await this.sleep(session, 260);
    this.emit(session, {
      type: 'task.done',
      taskId: session.id,
      status: 'completed',
      at: Date.now(),
    });
  }

  private async runFollowUp(session: MockSession, content: string): Promise<void> {
    await this.sleep(session, 400);
    if (session.cancelled) return;
    this.emit(session, {
      type: 'task.message',
      taskId: session.id,
      message: {
        role: 'assistant',
        content: `Understood: “${content.trim().slice(0, 120)}”. Let me check the current page state before I act.`,
        name: 'deepseek-v4-flash-free',
      },
      at: Date.now(),
    });
    await this.sleep(session, 260);
    await this.tool(
      session,
      'browser_snapshot',
      { includeHidden: false, maxDepth: 10 },
      'Captured 41 interactive elements',
      480,
      { elements: 41 },
    );
    await this.sleep(session, 240);
    this.emit(session, {
      type: 'task.message',
      taskId: session.id,
      message: {
        role: 'assistant',
        content: 'Nothing on the page contradicts that — proceeding with the next step.',
        name: 'deepseek-v4-flash-free',
      },
      at: Date.now(),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Seed data                                                               */
  /* ---------------------------------------------------------------------- */

  private seed(): void {
    const now = Date.now();
    this.seedCompleted(now);
    this.seedAwaitingApproval(now);
    this.seedRunning(now);
    this.seedFailed(now);
  }

  private makeSession(id: string, title: string, status: TaskStatus, createdAt: number): MockSession {
    const session: MockSession = {
      id,
      task: mockTask(id, title, status, createdAt),
      events: [],
      cancelled: false,
      timers: new Set(),
      wakeups: new Set(),
      pendingApproval: null,
    };
    this.sessions.set(id, session);
    return session;
  }

  private seedCompleted(now: number): void {
    const id = 'task_docs_markdown';
    const session = this.makeSession(id, 'Mirror the docs site into markdown', 'completed', now - 1_800_000);
    const t = (offset: number) => now - 1_800_000 + offset;

    this.emit(session, { type: 'task.created', taskId: id, title: 'Mirror the docs site into markdown', at: t(0) });
    this.emit(session, { type: 'task.status', taskId: id, status: 'running', at: t(120) });
    this.emit(session, {
      type: 'task.plan',
      taskId: id,
      plan: [
        { id: 'step-1', description: 'Crawl the docs sitemap', status: 'done' },
        { id: 'step-2', description: 'Convert each page to markdown', status: 'done' },
        { id: 'step-3', description: 'Write the mirror to disk', status: 'done' },
      ],
      at: t(200),
    });
    this.emit(session, {
      type: 'task.message',
      taskId: id,
      message: {
        role: 'assistant',
        content: 'I found 42 documentation pages. Converting them now.',
        name: 'deepseek-v4-flash-free',
      },
      at: t(300),
    });
    this.emit(session, {
      type: 'task.tool.start',
      taskId: id,
      callId: 'call_seed_1',
      toolName: 'browser_navigate',
      arguments: { url: 'https://docs.celeste.dev/sitemap.xml', waitUntil: 'networkidle' },
      at: t(400),
    });
    this.emit(session, {
      type: 'task.tool.end',
      taskId: id,
      callId: 'call_seed_1',
      toolName: 'browser_navigate',
      ok: true,
      summary: 'Loaded sitemap.xml (200)',
      durationMs: 640,
      data: { status: 200, urls: 42 },
      at: t(1040),
    });
    this.emit(session, {
      type: 'task.tool.start',
      taskId: id,
      callId: 'call_seed_2',
      toolName: 'browser_extract',
      arguments: { selector: 'main', format: 'markdown', recursive: true },
      at: t(1100),
    });
    this.emit(session, {
      type: 'task.tool.end',
      taskId: id,
      callId: 'call_seed_2',
      toolName: 'browser_extract',
      ok: true,
      summary: 'Extracted 42 pages',
      durationMs: 3100,
      data: { pages: 42, characters: 218_940 },
      at: t(4200),
    });
    const artifact: Artifact = {
      path: '~/celeste-output/docs-mirror.md',
      kind: 'md',
      bytes: 219_402,
      createdAt: t(4400),
      description: 'Concatenated documentation mirror',
    };
    this.emit(session, { type: 'task.artifact', taskId: id, artifact, at: t(4400) });
    this.emit(session, {
      type: 'task.message',
      taskId: id,
      message: {
        role: 'assistant',
        content: 'Mirror written — 42 pages, 214 KB. No injection attempts were detected in the scraped content.',
        name: 'deepseek-v4-flash-free',
      },
      at: t(4600),
    });
    this.emit(session, { type: 'task.done', taskId: id, status: 'completed', at: t(4800) });
  }

  private seedAwaitingApproval(now: number): void {
    const id = 'task_vendor_form';
    const session = this.makeSession(id, 'Submit the vendor onboarding form', 'awaiting_approval', now - 420_000);
    const t = (offset: number) => now - 420_000 + offset;

    this.emit(session, { type: 'task.created', taskId: id, title: 'Submit the vendor onboarding form', at: t(0) });
    this.emit(session, { type: 'task.status', taskId: id, status: 'running', at: t(80) });
    this.emit(session, {
      type: 'task.plan',
      taskId: id,
      plan: [
        { id: 'step-1', description: 'Open the vendor portal', status: 'done' },
        { id: 'step-2', description: 'Fill the company details', status: 'done' },
        { id: 'step-3', description: 'Submit for review', status: 'active' },
      ],
      at: t(160),
    });
    this.emit(session, {
      type: 'task.message',
      taskId: id,
      message: {
        role: 'assistant',
        content: 'Everything is filled in. I need your approval before I submit — this sends our company details to the vendor.',
        name: 'deepseek-v4-flash-free',
      },
      at: t(900),
    });
    this.emit(session, {
      type: 'task.tool.start',
      taskId: id,
      callId: 'call_seed_3',
      toolName: 'browser_type',
      arguments: { ref: 'e14', text: 'Celeste Labs' },
      at: t(400),
    });
    this.emit(session, {
      type: 'task.tool.end',
      taskId: id,
      callId: 'call_seed_3',
      toolName: 'browser_type',
      ok: true,
      summary: 'Typed into #company (3 fields)',
      durationMs: 220,
      data: { ok: true, fields: 3 },
      at: t(620),
    });
    const request: ApprovalRequest = {
      id: 'apr_seed_vendor',
      taskId: id,
      toolName: 'browser_submit_form',
      arguments: {
        selector: '#onboarding-form',
        fields: {
          company: 'Celeste Labs',
          email: 'ops@celeste.dev',
          plan: 'Team',
        },
      },
      reason: 'Submitting a form transmits company details to a third party. This action cannot be undone.',
      risk: 'high',
      createdAt: t(950),
    };
    this.emit(session, { type: 'task.approval', taskId: id, request, at: t(950) });
    this.emit(session, { type: 'task.status', taskId: id, status: 'awaiting_approval', at: t(960) });
    session.pendingApproval = {
      request,
      settle: () => undefined,
    };
  }

  private seedRunning(now: number): void {
    const id = 'task_revenue_brief';
    const session = this.makeSession(id, 'Compile the Q3 revenue brief', 'running', now - 90_000);
    const t = (offset: number) => now - 90_000 + offset;

    this.emit(session, { type: 'task.created', taskId: id, title: 'Compile the Q3 revenue brief', at: t(0) });
    this.emit(session, { type: 'task.status', taskId: id, status: 'running', at: t(60) });
    this.emit(session, {
      type: 'task.plan',
      taskId: id,
      plan: [
        { id: 'step-1', description: 'Pull the analytics dashboard', status: 'done' },
        { id: 'step-2', description: 'Reconcile against the billing export', status: 'active' },
        { id: 'step-3', description: 'Write the brief', status: 'pending' },
      ],
      at: t(120),
    });
    this.emit(session, {
      type: 'task.message',
      taskId: id,
      message: {
        role: 'user',
        content: 'Compile the Q3 revenue brief from the analytics dashboard.',
      },
      at: t(10),
    });
    this.emit(session, {
      type: 'task.message',
      taskId: id,
      message: {
        role: 'assistant',
        content: 'Dashboard is open. I am reconciling the numbers against the billing export now.',
        name: 'deepseek-v4-flash-free',
      },
      at: t(400),
    });
    this.emit(session, {
      type: 'task.tool.start',
      taskId: id,
      callId: 'call_seed_4',
      toolName: 'browser_navigate',
      arguments: { url: 'https://app.analytics.local/revenue', waitUntil: 'networkidle' },
      at: t(600),
    });
    this.emit(session, {
      type: 'task.tool.end',
      taskId: id,
      callId: 'call_seed_4',
      toolName: 'browser_navigate',
      ok: true,
      summary: 'Loaded /revenue (200)',
      durationMs: 880,
      data: { status: 200, title: 'Revenue – Analytics' },
      at: t(1480),
    });
    this.emit(session, {
      type: 'task.tool.start',
      taskId: id,
      callId: 'call_seed_5',
      toolName: 'read_file',
      arguments: { path: '~/Downloads/q3-billing.csv' },
      at: t(1600),
    });
    this.emit(session, {
      type: 'task.tool.end',
      taskId: id,
      callId: 'call_seed_5',
      toolName: 'read_file',
      ok: true,
      summary: 'Read q3-billing.csv (1.8 MB, 12,904 rows)',
      durationMs: 410,
      data: { bytes: 1_884_120, rows: 12_904 },
      at: t(2010),
    });

    // Keep the seeded session alive so the demo always has something moving.
    void this.keepAlive(session);
  }

  private async keepAlive(session: MockSession): Promise<void> {
    await this.sleep(session, 5200);
    if (session.cancelled) return;
    await this.tool(
      session,
      'browser_snapshot',
      { includeHidden: false, maxDepth: 9 },
      'Captured 28 elements on /revenue',
      520,
      { elements: 28 },
    );
    await this.sleep(session, 2600);
    if (session.cancelled) return;
    this.emit(session, {
      type: 'task.message',
      taskId: session.id,
      message: {
        role: 'assistant',
        content: 'Numbers reconciled. Drafting the brief now.',
        name: 'deepseek-v4-flash-free',
      },
      at: Date.now(),
    });
    await this.sleep(session, 3400);
    if (session.cancelled) return;
    const artifact: Artifact = {
      path: '~/celeste-output/q3-revenue-brief.docx',
      kind: 'docx',
      bytes: 42_118,
      createdAt: Date.now(),
      description: 'Q3 revenue brief with variance analysis',
    };
    this.emit(session, { type: 'task.artifact', taskId: session.id, artifact, at: Date.now() });
    this.emit(session, { type: 'task.done', taskId: session.id, status: 'completed', at: Date.now() });
  }

  private seedFailed(now: number): void {
    const id = 'task_analytics_export';
    const session = this.makeSession(id, 'Export analytics to a spreadsheet', 'failed', now - 7_200_000);
    const t = (offset: number) => now - 7_200_000 + offset;

    this.emit(session, { type: 'task.created', taskId: id, title: 'Export analytics to a spreadsheet', at: t(0) });
    this.emit(session, { type: 'task.status', taskId: id, status: 'running', at: t(80) });
    this.emit(session, {
      type: 'task.message',
      taskId: id,
      message: { role: 'user', content: 'Export the revenue analytics to a spreadsheet.' },
      at: t(10),
    });
    this.emit(session, {
      type: 'task.tool.start',
      taskId: id,
      callId: 'call_seed_6',
      toolName: 'browser_navigate',
      arguments: { url: 'https://app.analytics.local/export' },
      at: t(300),
    });
    this.emit(session, {
      type: 'task.tool.end',
      taskId: id,
      callId: 'call_seed_6',
      toolName: 'browser_navigate',
      ok: false,
      summary: 'Navigation failed',
      durationMs: 5300,
      error: { code: 'NAVIGATION_FAILED', message: 'net::ERR_TIMED_OUT after 5s' },
      at: t(5600),
    });
    this.emit(session, {
      type: 'task.message',
      taskId: id,
      message: {
        role: 'assistant',
        content:
          'The export endpoint did not respond, so I could not pull the data. I can retry, or you can export it manually and point me at the file.',
        name: 'deepseek-v4-flash-free',
      },
      at: t(5800),
    });
    this.emit(session, { type: 'task.status', taskId: id, status: 'failed', at: t(5900) });
    this.emit(session, { type: 'task.done', taskId: id, status: 'failed', at: t(5950) });
  }
}
