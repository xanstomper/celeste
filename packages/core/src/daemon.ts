import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ModelGateway, loadConfig } from '@celeste/gateway';
import type { CelesteConfig } from '@celeste/gateway';
import { buildRegistry } from '@celeste/tools';
import { Agent } from './agent/agent.js';
import { ApprovalManager } from './agent/approval.js';
import { BrowserBridge } from './browser/bridge.js';
import { SessionGuard } from './browser/session-guard.js';
import { Daemon } from './daemon/server.js';
import { EventBus } from './events.js';
import { TaskStore } from './store.js';

export const DEFAULT_DAEMON_PORT = 9126;
export const DEFAULT_BRIDGE_PORT = 9223;

export interface StartDaemonOptions {
  /** HTTP port for the daemon API and UI. */
  port?: number;
  /** Port the browser extension connects to. */
  bridgePort?: number;
  /** Path to a config file. */
  configPath?: string;
  /** Override the active provider. */
  providerId?: string;
  /** Directory generated files are written to. */
  outputDir?: string;
  /** Auto-approve risky actions. */
  autoApprove?: boolean;
  /** Maximum agent steps per task. */
  maxSteps?: number;
  /** Start the HTTP + WebSocket listeners. */
  serve?: boolean;
  /** Start the browser bridge listener. */
  serveBridge?: boolean;
}

export interface RunningDaemon {
  config: CelesteConfig;
  gateway: ModelGateway;
  bus: EventBus;
  store: TaskStore;
  bridge: BrowserBridge;
  sessionGuard: SessionGuard;
  approvals: ApprovalManager;
  agent: Agent;
  daemon: Daemon | null;
  stop(): Promise<void>;
}

/**
 * Boots the whole Celeste stack: model gateway, tool registry, browser
 * bridge, task store, agent runtime and (optionally) the HTTP API.
 */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const config = await loadConfig(options.configPath);

  const outputDir = options.outputDir ?? config.outputDir ?? process.cwd();
  await fs.mkdir(outputDir, { recursive: true });

  const bus = new EventBus();

  const gateway = new ModelGateway(config.providers, {
    onProviderChange: (provider) => {
      bus.publish({
        type: 'provider.changed',
        providerId: provider.id,
        model: provider.model,
        at: Date.now(),
      });
    },
  });

  const activeId = options.providerId ?? config.activeProvider;
  if (activeId) {
    try {
      gateway.setActiveProvider(activeId);
    } catch {
      // Fall back to whatever the gateway picks by default.
    }
  }

  const bridgePort = options.bridgePort ?? config.bridgePort ?? DEFAULT_BRIDGE_PORT;
  const bridge = new BrowserBridge({
    port: bridgePort,
    timeoutMs: config.browserTimeoutMs ?? 30_000,
  });

  const sessionGuard = new SessionGuard();

  bridge.on('debug', (detail) => {
    bus.publish({
      type: 'log',
      level: 'debug',
      message: `bridge: ${JSON.stringify(detail)}`,
      at: Date.now(),
    });
  });
  bridge.on('extension-event', (event) => {
    const changed = sessionGuard.ingest(event);
    if (changed) {
      bus.publish({
        type: 'log',
        level: changed.health === 'ok' ? 'info' : 'warn',
        message: `Session health: ${changed.health} — ${changed.detail ?? ''}`,
        at: Date.now(),
      });
    }
    if (changed && changed.health !== 'ok') {
      bus.publish({
        type: 'task.human',
        taskId: '*',
        reason: changed.detail ?? 'Human intervention required.',
        at: Date.now(),
      });
    }
  });

  const store = new TaskStore(config.dataDir ?? path.join(process.cwd(), '.celeste', 'data'));
  await store.load();

  const registry = buildRegistry({
    browser: {
      isConnected: () => bridge.isConnected,
      send: (action, params, opts) => bridge.send(action, params, opts),
    },
    allowedRoots: [process.cwd(), outputDir],
    browserTimeoutMs: config.browserTimeoutMs ?? 30_000,
  });

  const approvals = new ApprovalManager(bus);

  // The page's "Ask" button asks the daemon to start working on the current
  // page. It arrives over the same bridge the browser commands use, so no
  // knowledge of the daemon's HTTP port is needed.
  bridge.on('task-request', (payload: { prompt?: string; url?: string; title?: string }) => {
    const prompt = String(payload.prompt ?? '').trim();
    if (!prompt) return;

    const task = store.create(prompt.slice(0, 120));
    store.appendMessage(task.id, { role: 'user', content: prompt });
    bus.publish({
      type: 'task.created',
      taskId: task.id,
      title: task.title,
      at: Date.now(),
    });
    void agent.run(task.id).catch((err) => {
      bus.publish({
        type: 'log',
        level: 'error',
        message: `Task ${task.id} crashed: ${err instanceof Error ? err.message : String(err)}`,
        at: Date.now(),
      });
    });
  });

  const agent = new Agent({
    gateway,
    registry,
    store,
    bus,
    approvals,
    sessionGuard,
    providerId: options.providerId,
    maxSteps: options.maxSteps ?? config.maxSteps ?? 40,
    outputDir,
    autoApprove: options.autoApprove,
  });

  let daemon: Daemon | null = null;
  if (options.serve !== false) {
    daemon = new Daemon({
      port: options.port ?? DEFAULT_DAEMON_PORT,
      gateway,
      store,
      bus,
      agent,
      approvals,
      bridge,
      sessionGuard,
    });
    await daemon.start();
  }

  if (options.serveBridge !== false) {
    try {
      await bridge.start();
    } catch (err) {
      bus.publish({
        type: 'log',
        level: 'warn',
        message: `Browser bridge failed to start on port ${bridgePort}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        at: Date.now(),
      });
    }
  }

  bus.publish({
    type: 'extension.status',
    connected: bridge.isConnected,
    at: Date.now(),
  });

  return {
    config,
    gateway,
    bus,
    store,
    bridge,
    sessionGuard,
    approvals,
    agent,
    daemon,
    async stop() {
      await bridge.stop();
      if (daemon) await daemon.stop();
      await store.checkpointAll();
    },
  };
}
