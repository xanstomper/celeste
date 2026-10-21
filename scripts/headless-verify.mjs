#!/usr/bin/env node
/**
 * The headless verification harness.
 *
 * Everything Celeste is tested against runs here: a throwaway daemon on its
 * own port, its own bridge, its own data directory, and the headless browser
 * (the daemon's fallback browser never opens a window - see
 * `packages/core/src/browser/cdp-browser.ts`).
 *
 * The user's own browser is never touched: their extension stays on port
 * 9223 with the daemon on 9126, while this harness uses 9224 and 9127.
 *
 *   node scripts/headless-verify.mjs                 # run every check
 *   node scripts/headless-verify.mjs vision          # run one check
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = '/tmp/opencode/celeste-headless';
const API_PORT = 9127;
const BRIDGE_PORT = 9224;

const CONFIG = {
  activeProvider: 'local-glm',
  outputDir: `${WORK}/output`,
  dataDir: `${WORK}/data`,
  bridgePort: BRIDGE_PORT,
  maxSteps: 6,
  providers: [
    {
      id: 'local-glm',
      kind: 'openai-compatible',
      label: 'Local router · GLM-5.3 Flash',
      baseUrl: 'http://localhost:8705/v1',
      model: 'glm-5.3-flash',
      supportsTools: true,
      supportsVision: true,
      stream: false,
    },
  ],
};

let daemon = null;

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function api(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${API_PORT}${pathname}`, options);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Starts the throwaway daemon. */
async function startDaemon() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(`${WORK}/output`, { recursive: true });
  mkdirSync(`${WORK}/data`, { recursive: true });
  const configPath = `${WORK}/celeste.config.json`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(configPath, JSON.stringify(CONFIG, null, 2));

  daemon = spawn(
    process.execPath,
    [
      path.join(ROOT, 'apps/cli/dist/index.js'),
      'serve',
      '--port',
      String(API_PORT),
      '--bridge-port',
      String(BRIDGE_PORT),
      '--config',
      configPath,
    ],
    {
      cwd: WORK,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CELESTE_HEADFUL: '0' },
    },
  );
  daemon.unref();

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    try {
      const health = await api('/api/health');
      if (health) return;
    } catch {
      /* not up yet */
    }
  }
  throw new Error('The headless daemon did not start.');
}

/** Stops the throwaway daemon. */
async function stopDaemon() {
  if (!daemon) return;
  try {
    process.kill(-daemon.pid, 'SIGTERM');
  } catch {
    try {
      daemon.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await sleep(500);
}

/** Runs a task and waits for it to finish. */
async function runTask(prompt, options = {}) {
  const body = JSON.stringify({
    prompt,
    providerId: options.providerId ?? 'local-glm',
    focus: options.focus ?? 'web',
    depth: options.depth ?? 'quick',
    autoApprove: true,
    ...(options.attachments ? { attachments: options.attachments } : {}),
  });
  const created = await api('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const id = created?.task?.id;
  if (!id) throw new Error(`Could not create a task: ${JSON.stringify(created).slice(0, 200)}`);

  const started = Date.now();
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(1000);
    const list = await api('/api/sessions');
    const task = list?.tasks?.find((item) => item.id === id);
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) {
      const detail = await api(`/api/sessions/${id}`);
      return { ...(detail?.task ?? task), elapsedMs: Date.now() - started };
    }
  }
  throw new Error('The task did not finish in time.');
}

function answerOf(task) {
  return (task.messages ?? [])
    .filter((message) => message.role === 'assistant')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : (message.content ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(' '),
    )
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

const checks = {
  /** A plain question is answered by the local router. */
  async text() {
    const task = await runTask('Say OK and nothing else.');
    const answer = answerOf(task);
    if (task.status !== 'completed') {
      throw new Error(`Expected completed, got ${task.status}: ${task.error?.message ?? ''}`);
    }
    if (!/ok/i.test(answer)) throw new Error(`Unexpected answer: ${answer.slice(0, 120)}`);
    return `answered "${answer.trim().slice(0, 40)}" in ${(task.elapsedMs / 1000).toFixed(1)}s`;
  },

  /** An attached image is really read by the model. */
  async vision() {
    const { readFileSync } = await import('node:fs');
    const imagePath = '/tmp/opencode/vision-test.png';
    if (!existsSync(imagePath)) throw new Error(`Missing test image ${imagePath}`);
    const data = readFileSync(imagePath).toString('base64');
    const task = await runTask(
      'What exact text is written in the attached image? Reply with the text only.',
      {
        attachments: [{ name: 'vision-test.png', mimeType: 'image/png', data }],
      },
    );
    const answer = answerOf(task);
    if (task.status !== 'completed') {
      throw new Error(`Expected completed, got ${task.status}: ${task.error?.message ?? ''}`);
    }
    if (!/CELESTE-?7391/i.test(answer)) {
      throw new Error(`The image was not read: ${answer.slice(0, 120)}`);
    }
    return `read the image in ${(task.elapsedMs / 1000).toFixed(1)}s`;
  },

  /** A visual canvas is written as a real canvas, not a chat dump. */
  async canvas() {
    const task = await runTask(
      'Use canvas_write with kind visual to make a one-page dashboard about the solar system. Keep it short.',
    );
    if (task.status !== 'completed') {
      throw new Error(`Expected completed, got ${task.status}: ${task.error?.message ?? ''}`);
    }
    if (!task.canvas) throw new Error('No canvas was written.');
    return `canvas "${task.canvas.kind}" with ${task.canvas.content?.length ?? 0} characters in ${(task.elapsedMs / 1000).toFixed(1)}s`;
  },
};

/* -------------------------------------------------------------------------- */

async function main() {
  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : Object.keys(checks);
  await startDaemon();
  let failures = 0;
  try {
    for (const name of names) {
      const check = checks[name];
      if (!check) {
        log(`? unknown check "${name}"`);
        continue;
      }
      const started = Date.now();
      try {
        const detail = await check();
        log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s) - ${detail}`);
      } catch (error) {
        failures += 1;
        log(`FAIL ${name} - ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await stopDaemon();
  }
  log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  await stopDaemon();
  log(`harness error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
