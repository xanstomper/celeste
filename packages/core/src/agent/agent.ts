import { createId } from '@celeste/protocol';
import type { ChatMessage, PlanStep, ToolCall, ToolResult } from '@celeste/protocol';
import { CelesteError, PROTOCOL_VERSION } from '@celeste/protocol';
import type { ModelGateway } from '@celeste/gateway';
import type { ToolRegistry, ToolContext } from '@celeste/tools';
import type { BrowserClient } from '@celeste/tools';
import type { EventBus } from '../events.js';
import type { TaskStore } from '../store.js';
import { cleanAnswer } from './answer.js';
import { shouldPlan } from './plan-policy.js';
import type { ApprovalManager } from './approval.js';
import type { SessionGuard } from '../browser/session-guard.js';
import { assessRisk, buildInjectionWarning, neutraliseUntrustedText } from './guardrails.js';
import {
  buildTurnContext,
  COMPACT_SYSTEM_PROMPT,
  depthGuidance,
  focusGuidance,
  PLANNER_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from './prompts.js';

export interface AgentRunOptions {
  /** Override the provider for this run only. */
  providerId?: string;
  /** Skip the approval gate for this run only. */
  autoApprove?: boolean;
  /** Override the maximum number of steps for this run. */
  maxSteps?: number;
  /** Override where generated files are written for this run. */
  outputDir?: string;
}

export interface AgentOptions {
  gateway: ModelGateway;
  registry: ToolRegistry;
  store: TaskStore;
  bus: EventBus;
  approvals: ApprovalManager;
  sessionGuard: SessionGuard;
  /** The browser, so tools can search and read pages directly. */
  browser?: BrowserClient;
  /** Provider override for this run. */
  providerId?: string;
  /** Maximum number of model round-trips. */
  maxSteps?: number;
  /** Where generated files are written. */
  outputDir?: string;
  /** Auto-approve risky actions (demo mode). */
  autoApprove?: boolean;
  /**
   * How long a run waits for the user to clear a sign-in prompt or CAPTCHA
   * before it pauses. Defaults to two minutes.
   */
  guardWaitMs?: number;
}

/**
 * The Celeste agent.
 *
 * A single run is: plan → act → observe → verify → repeat. Each model
 * round-trip may request tools; the results come back as tool messages; the
 * loop continues until the model stops asking for tools or a limit is hit.
 */
export class Agent {
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(private readonly options: AgentOptions) {}

  /** Cancels a running task. */
  cancel(taskId: string): boolean {
    const controller = this.abortControllers.get(taskId);
    if (!controller) return false;
    controller.abort();
    this.abortControllers.delete(taskId);
    return true;
  }

  /** Runs a task to completion (or failure). */
  async run(taskId: string, overrides: AgentRunOptions = {}): Promise<void> {
    const task = this.options.store.get(taskId);
    if (!task) return;

    const providerId = overrides.providerId ?? this.options.providerId;
    const autoApprove = overrides.autoApprove ?? this.options.autoApprove ?? false;
    const maxSteps = overrides.maxSteps ?? this.options.maxSteps ?? 40;

    const controller = new AbortController();
    this.abortControllers.set(taskId, controller);

    try {
      this.setStatus(taskId, 'running');
      await this.options.store.checkpoint(taskId);

      // 1. Plan, if the job is big enough to need one and we do not already
      // have one.
      const prompt = task.messages.find((message) => message.role === 'user');
      const promptText = typeof prompt?.content === 'string' ? prompt.content : task.title;
      if (task.plan.length === 0 && shouldPlan(promptText, task.depth)) {
        await this.createPlan(taskId, controller.signal, providerId);
      }

      // 2. Act.
      await this.loop(taskId, controller.signal, {
        providerId,
        autoApprove,
        maxSteps,
        outputDir: overrides.outputDir ?? this.options.outputDir,
      });
    } catch (err) {
      const error = CelesteError.from(err);
      if (error.code === 'CANCELLED' || controller.signal.aborted) {
        this.setStatus(taskId, 'cancelled');
      } else {
        this.options.store.update(taskId, (t) => {
          t.status = 'failed';
          t.error = error.toShape();
        });
        this.options.bus.publish({
          type: 'log',
          level: 'error',
          message: `Task ${taskId} failed: ${error.message}`,
          at: Date.now(),
        });
      }
    } finally {
      this.abortControllers.delete(taskId);
      await this.options.store.checkpoint(taskId);
      const final = this.options.store.get(taskId);
      this.options.bus.publish({
        type: 'task.done',
        taskId,
        status:
          final?.status === 'completed'
            ? 'completed'
            : final?.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
        at: Date.now(),
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Planning                                                               */
  /* ---------------------------------------------------------------------- */

  private async createPlan(
    taskId: string,
    signal: AbortSignal,
    providerId?: string,
  ): Promise<void> {
    const task = this.options.store.get(taskId);
    if (!task) return;

    const userMessage = task.messages.find((m) => m.role === 'user');
    const goal = typeof userMessage?.content === 'string' ? userMessage.content : task.title;

    const response = await this.options.gateway.chat(
      {
        messages: [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT },
          { role: 'user', content: goal },
        ],
        temperature: 0.2,
        signal,
      },
      providerId,
    );

    const text = typeof response.message.content === 'string' ? response.message.content : '';
    const steps = parsePlan(text);

    const plan: PlanStep[] =
      steps.length > 0
        ? steps.map((s, i) => ({
            id: s.id ?? `s${i + 1}`,
            description: s.description,
            status: i === 0 ? 'active' : 'pending',
          }))
        : [{ id: 's1', description: goal, status: 'active' }];

    this.options.store.setPlan(taskId, plan);
    this.options.bus.publish({ type: 'task.plan', taskId, plan, at: Date.now() });
  }

  /* ---------------------------------------------------------------------- */
  /* Main loop                                                              */
  /* ---------------------------------------------------------------------- */

  private async loop(
    taskId: string,
    signal: AbortSignal,
    run: { providerId?: string; autoApprove: boolean; maxSteps: number; outputDir?: string },
  ): Promise<void> {
    const maxSteps = run.maxSteps;
    let consecutiveFailures = 0;

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) {
        this.setStatus(taskId, 'cancelled');
        return;
      }

      // If the browser session died or a CAPTCHA appeared, stop and ask.
      if (this.options.sessionGuard.blocked) {
        const status = this.options.sessionGuard.current;
        this.setStatus(taskId, 'awaiting_human');
        this.options.bus.publish({
          type: 'task.human',
          taskId,
          reason: status.detail ?? 'Human intervention required.',
          at: Date.now(),
        });
        // Wait a little: the user may solve the challenge, or the page may
        // move on, and the guard will clear itself. Then carry on.
        const cleared = await this.waitForGuard(signal);
        if (!cleared) return;
        this.setStatus(taskId, 'running');
        continue;
      }

      const task = this.options.store.get(taskId);
      if (!task) return;

      const messages = this.buildMessages(taskId);
      const tools = this.options.registry.list();

      const response = await this.options.gateway.chat(
        {
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          signal,
          // The panel paints the answer as it is written. The full message
          // still arrives at the end and replaces the preview, so a provider
          // that cannot stream simply shows up all at once.
          onDelta: (delta) =>
            this.options.bus.publish({
              type: 'task.delta',
              taskId,
              delta,
              at: Date.now(),
            }),
        },
        run.providerId,
      );

      const toolCalls = response.toolCalls ?? [];

      // Only the final message is the answer the user reads; earlier
      // assistant turns are working notes that carry tool calls. Tidy just
      // the answer, so its text and its streamed event agree.
      const message =
        toolCalls.length === 0 && typeof response.message.content === 'string'
          ? { ...response.message, content: cleanAnswer(response.message.content) }
          : response.message;

      this.options.store.appendMessage(taskId, message);
      this.options.bus.publish({
        type: 'task.message',
        taskId,
        message,
        at: Date.now(),
      });

      if (toolCalls.length === 0) {
        // The model finished. Mark the plan done and stop.
        this.completePlan(taskId);
        this.setStatus(taskId, 'completed');
        return;
      }

      let stepFailed = false;

      for (const call of toolCalls) {
        const result = await this.runTool(taskId, call, signal, run.autoApprove, run.outputDir);
        this.options.store.appendMessage(taskId, {
          role: 'tool',
          content: renderToolResultForModel(result),
          toolCallId: call.id,
          name: call.name,
        });
        if (!result.ok) stepFailed = true;
      }

      consecutiveFailures = stepFailed ? consecutiveFailures + 1 : 0;

      // Three consecutive failed steps: the agent is stuck. Stop and report.
      if (consecutiveFailures >= 3) {
        this.options.store.update(taskId, (t) => {
          t.status = 'failed';
          t.error = {
            code: 'INTERNAL',
            message:
              'Three consecutive tool steps failed without progress. Stopping to avoid a loop.',
            retryable: false,
          };
        });
        this.options.bus.publish({
          type: 'log',
          level: 'error',
          message: `Task ${taskId}: three consecutive failures, aborting to avoid a loop.`,
          at: Date.now(),
        });
        return;
      }

      await this.options.store.checkpoint(taskId);
    }

    this.options.store.update(taskId, (t) => {
      t.status = 'failed';
      t.error = {
        code: 'INTERNAL',
        message: `Reached the maximum of ${maxSteps} steps.`,
        retryable: true,
      };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Tool execution                                                         */
  /* ---------------------------------------------------------------------- */

  private async runTool(
    taskId: string,
    call: ToolCall,
    signal: AbortSignal,
    autoApprove: boolean,
    outputDir?: string,
  ): Promise<ToolResult> {
    const definition = this.options.registry.get(call.name);

    this.options.bus.publish({
      type: 'task.tool.start',
      taskId,
      callId: call.id,
      toolName: call.name,
      arguments: call.arguments,
      at: Date.now(),
    });

    const started = Date.now();

    // Approval gate.
    const assessment = assessRisk(call, definition?.definition, {
      ...defaultPolicy(),
      autoApprove,
    });

    if (assessment.requiresApproval) {
      this.setStatus(taskId, 'awaiting_approval');
      const approved = await this.options.approvals.request(taskId, {
        toolName: call.name,
        arguments: call.arguments,
        reason: assessment.reason,
        risk: assessment.risk,
      });
      if (!approved) {
        const result: ToolResult = {
          id: call.id,
          name: call.name,
          ok: false,
          summary: 'Denied by the user.',
          error: {
            code: 'NEEDS_APPROVAL',
            message: 'The user denied this action. Do not retry it; continue with another approach or report back.',
            retryable: false,
          },
          durationMs: Date.now() - started,
        };
        this.finishTool(taskId, result);
        return result;
      }
      this.setStatus(taskId, 'running');
    }

    let result: ToolResult;
    try {
      const ctx = this.buildContext(taskId, signal, outputDir);
      result = await this.options.registry.execute(call, ctx);
    } catch (err) {
      const error = CelesteError.from(err);
      result = {
        id: call.id,
        name: call.name,
        ok: false,
        summary: error.message,
        error: error.toShape(),
        durationMs: Date.now() - started,
      };
    }

    // Scan content-bearing results for prompt injection.
    result = this.scrubResult(result);

    this.finishTool(taskId, result);
    return result;
  }

  private finishTool(taskId: string, result: ToolResult): void {
    // Keep the task's source list up to date so a reopened thread still has
    // its citations.
    if (result.sources && result.sources.length > 0) {
      this.options.store.update(taskId, (task) => {
        const existing = task.sources ?? [];
        const known = new Set(existing.map((source) => source.n));
        const merged = [...existing];
        for (const source of result.sources ?? []) {
          if (!known.has(source.n)) {
            known.add(source.n);
            merged.push(source);
          }
        }
        task.sources = merged;
      });
    }

    this.options.bus.publish({
      type: 'task.tool.end',
      taskId,
      callId: result.id,
      toolName: result.name,
      ok: result.ok,
      summary: result.summary,
      durationMs: result.durationMs ?? 0,
      ...(result.sources && result.sources.length > 0 ? { sources: result.sources } : {}),
      data: result.data,
      error: result.error ? { code: result.error.code, message: result.error.message } : undefined,
      at: Date.now(),
    });
  }

  /**
   * Neutralises prompt-injection attempts found in tool output.
   *
   * Only content-bearing tools are inspected — snapshots, extracted text and
   * page text. Structured data (JSON from a network capture) is left alone
   * unless it contains long natural-language strings.
   */
  private scrubResult(result: ToolResult): ToolResult {
    if (!result.ok) return result;
    const text = extractTextPayload(result);
    if (!text || text.length < 40) return result;

    const { text: neutralised, findings } = neutraliseUntrustedText(text);
    if (findings.length === 0) return result;

    const warning = buildInjectionWarning(findings);
    const summary = `${result.summary} — ${findings.length} prompt-injection attempt(s) neutralised`;

    const patched: ToolResult = {
      ...result,
      summary,
      text: neutralised,
    };

    if (result.data && typeof result.data === 'object') {
      patched.data = replaceTextInData(result.data, text, neutralised);
    }

    // Surface the warning to the model as a note in the tool message.
    patched.text = `${patched.text ?? ''}\n\n${warning}`.trim();

    return patched;
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Waits for the session guard to clear.
   *
   * The user is being asked to solve a challenge or sign in again. Polling
   * for a couple of minutes means the run resumes by itself the moment they
   * are done, instead of having to be restarted.
   */
  private async waitForGuard(signal: AbortSignal): Promise<boolean> {
    const guard = this.options.sessionGuard;
    if (!guard.blocked) return true;

    const waitMs = this.options.guardWaitMs ?? 120_000;
    if (waitMs <= 0 || signal.aborted) return false;

    // Listen rather than poll: the moment the user clears the challenge the
    // run continues, with no up-to-two-second dead time.
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        guard.off('change', onChange);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };

      const onChange = (): void => {
        if (!guard.blocked) finish(true);
      };
      const onAbort = (): void => finish(false);

      timer = setTimeout(() => finish(!guard.blocked), waitMs);
      guard.on('change', onChange);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private buildContext(taskId: string, signal: AbortSignal, outputDir?: string): ToolContext {
    return {
      taskId,
      signal,
      bus: this.options.bus,
      store: this.options.store,
      ...(this.options.browser ? { browser: this.options.browser } : {}),
      outputDir: outputDir ?? this.options.outputDir ?? process.cwd(),
      approval: {
        request: (req) => this.options.approvals.request(taskId, req),
      },
      scratch: {
        get: <T = unknown>(key: string): T | undefined =>
          this.options.store.get(taskId)?.scratch[key] as T | undefined,
        set: (key, value) => {
          this.options.store.update(taskId, (t) => {
            t.scratch[key] = value;
          });
        },
        delete: (key) => {
          this.options.store.update(taskId, (t) => {
            delete t.scratch[key];
          });
        },
        keys: () => Object.keys(this.options.store.get(taskId)?.scratch ?? {}),
      },
      emitArtifact: (artifact) => {
        this.options.store.addArtifact(taskId, artifact);
        this.options.bus.publish({ type: 'task.artifact', taskId, artifact, at: Date.now() });
      },
    };
  }

  private buildMessages(taskId: string): ChatMessage[] {
    const task = this.options.store.get(taskId);
    if (!task) return [];

    const activeStep = task.plan.find((s) => s.status === 'active');
    const context = buildTurnContext({
      plan: task.plan,
      activeStep: activeStep?.description,
      outputDir: this.options.outputDir,
    });

    const guidance = [focusGuidance(task.focus), depthGuidance(task.depth)]
      .filter(Boolean)
      .join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(guidance ? [{ role: 'system' as const, content: guidance }] : []),
      ...task.messages,
    ];

    if (context) {
      messages.push({ role: 'user', content: context });
    }
    return messages;
  }

  private completePlan(taskId: string): void {
    const task = this.options.store.get(taskId);
    if (!task) return;
    const plan = task.plan.map((step) =>
      step.status === 'pending' || step.status === 'active'
        ? { ...step, status: 'done' as const }
        : step,
    );
    this.options.store.setPlan(taskId, plan);
    this.options.bus.publish({ type: 'task.plan', taskId, plan, at: Date.now() });
  }

  private setStatus(taskId: string, status: TaskState['status']): void {
    this.options.store.update(taskId, (t) => {
      t.status = status;
    });
    this.options.bus.publish({ type: 'task.status', taskId, status, at: Date.now() });
  }
}

type TaskState = import('@celeste/protocol').TaskState;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function defaultPolicy() {
  return {
    alwaysRequireApproval: [
      'browser_click',
      'browser_type',
      'browser_fill',
      'browser_press',
      'browser_select',
      'browser_cookies',
      'file_write',
      'file_delete',
      'file_move',
      'document_create',
      'shell_exec',
      'credential_use',
      'credential_store',
    ],
    sensitiveUrlPatterns: [] as RegExp[],
    autoApprove: false,
  };
}

interface ParsedStep {
  id?: string;
  description: string;
}

/** Extracts a plan from the planner model's output, tolerating prose. */
export function parsePlan(text: string): ParsedStep[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  let json = trimmed;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) json = fenced[1].trim();
  const braceStart = json.indexOf('{');
  const braceEnd = json.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) json = json.slice(braceStart, braceEnd + 1);

  try {
    const parsed = JSON.parse(json) as { steps?: unknown };
    const steps = parsed.steps;
    if (Array.isArray(steps)) {
      return steps
        .map((step, i) => {
          if (typeof step === 'string') return { id: `s${i + 1}`, description: step };
          const obj = step as { id?: unknown; description?: unknown; step?: unknown };
          const description =
            typeof obj.description === 'string'
              ? obj.description
              : typeof obj.step === 'string'
                ? obj.step
                : '';
          return { id: typeof obj.id === 'string' ? obj.id : `s${i + 1}`, description };
        })
        .filter((s) => s.description.trim().length > 0);
    }
  } catch {
    /* fall through to line parsing */
  }

  // Fallback: treat each non-empty line as a step.
  return trimmed
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 4)
    .map((description, i) => ({ id: `s${i + 1}`, description }));
}

/** Renders a tool result as the text the model will read. */
export function renderToolResultForModel(result: ToolResult): string {
  if (!result.ok) {
    const code = result.error?.code ?? 'INTERNAL';
    return `TOOL ERROR (${code}): ${result.error?.message ?? result.summary}\nDo not retry the same call unchanged. Change your approach.`;
  }
  if (result.text) return result.text;
  if (result.data !== undefined) {
    try {
      return JSON.stringify(result.data, null, 2);
    } catch {
      return String(result.data);
    }
  }
  return result.summary;
}

/** Pulls natural-language text out of a tool result for injection scanning. */
function extractTextPayload(result: ToolResult): string | undefined {
  if (result.text && result.text.length > 40) return result.text;

  const data = result.data;
  if (!data || typeof data !== 'object') return undefined;

  const obj = data as Record<string, unknown>;
  const candidates = [obj.text, obj.markdown, obj.content, obj.body];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 40) return candidate;
  }

  // A snapshot's element list is textual enough to be worth scanning.
  const elements = obj.elements;
  if (Array.isArray(elements)) {
    const joined = elements
      .map((el) => {
        const e = el as { name?: unknown; role?: unknown };
        return `${String(e.role ?? '')} ${String(e.name ?? '')}`;
      })
      .join('\n');
    if (joined.length > 40) return joined;
  }

  return undefined;
}

/** Replaces the original text inside a tool result's structured payload. */
function replaceTextInData(data: unknown, original: string, replacement: string): unknown {
  if (typeof data === 'string') return data === original ? replacement : data;
  if (Array.isArray(data)) {
    return data.map((item) => replaceTextInData(item, original, replacement));
  }
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      out[key] = replaceTextInData(value, original, replacement);
    }
    return out;
  }
  return data;
}

export { COMPACT_SYSTEM_PROMPT, createId, PROTOCOL_VERSION };
