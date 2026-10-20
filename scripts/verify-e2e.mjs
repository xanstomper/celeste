/**
 * End-to-end verification for Celeste.
 *
 * Stands up:
 *   1. a mock OpenAI-compatible model server
 *   2. a mock browser extension that speaks the real protocol over WebSocket
 *
 * then drives a complete agent task through the real daemon and asserts that a
 * real .docx file lands on disk.
 *
 * Run: node /tmp/opencode/e2e.mjs   (from a dir where `ws` resolves)
 */
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MODEL_PORT = 8899;
const BRIDGE_PORT = 9233;
const API_PORT = 9136;
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT_DIR = path.join(REPO, '.artifacts', 'e2e');

let modelTurn = 0;
const modelCalls = [];

/* 1. Mock model server --------------------------------------------------- */

const modelServer = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    modelCalls.push(body);

    const isPlanner = body.messages.some(
      (m) => m.role === 'system' && String(m.content).includes('planner'),
    );

    let message;
    if (isPlanner) {
      message = {
        role: 'assistant',
        content: JSON.stringify({
          steps: [
            { id: 's1', description: 'Open the pricing page' },
            { id: 's2', description: 'Read the pricing' },
            { id: 's3', description: 'Write a report' },
          ],
        }),
      };
    } else {
      modelTurn++;
      if (modelTurn === 1) {
        message = {
          role: 'assistant',
          content: 'Let me open the page.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'browser_navigate',
                arguments: JSON.stringify({ url: 'https://example.com/pricing' }),
              },
            },
          ],
        };
      } else if (modelTurn === 2) {
        message = {
          role: 'assistant',
          content: 'Now let me read it.',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'browser_snapshot', arguments: JSON.stringify({}) },
            },
          ],
        };
      } else if (modelTurn === 3) {
        message = {
          role: 'assistant',
          content: 'Now writing the report.',
          tool_calls: [
            {
              id: 'call_3',
              type: 'function',
              function: {
                name: 'document_create',
                arguments: JSON.stringify({
                  kind: 'docx',
                  title: 'Pricing Report',
                  fileName: 'pricing-report.docx',
                  spec: {
                    title: 'Pricing Report',
                    author: 'Celeste',
                    blocks: [
                      { type: 'heading', level: 1, text: 'Pricing Report' },
                      { type: 'paragraph', text: 'Acme Cloud costs $29 per month for the Pro tier.' },
                      { type: 'bullet', text: 'Pro tier — $29/month' },
                      { type: 'bullet', text: 'Enterprise — custom pricing' },
                      {
                        type: 'table',
                        table: {
                          headers: ['Plan', 'Price'],
                          rows: [['Pro', '$29/mo'], ['Enterprise', 'Custom']],
                        },
                      },
                      { type: 'code', text: 'npm install acme', language: 'bash' },
                    ],
                  },
                }),
              },
            },
          ],
        };
      } else {
        message = {
          role: 'assistant',
          content:
            'Done. Acme Cloud Pro is $29 per month. The report is saved as pricing-report.docx.',
        };
      }
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: 'mock-model',
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
    return;
  }
  res.writeHead(404).end('{}');
});

/* 2. Mock extension ------------------------------------------------------ */

const extensionCommands = [];
let extensionSocket;

/**
 * Connects the mock extension to the daemon's bridge, exactly as the real
 * extension does: the daemon listens, the extension dials out.
 */
function connectExtension(port = BRIDGE_PORT) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    extensionSocket = socket;
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

function handleExtension(socket) {
  console.log('  [extension] connected');
  socket.send(
    JSON.stringify({ v: '1.0.0', type: 'hello', payload: { version: '0.1.0', userAgent: 'mock' } }),
  );

  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'browser.command') return;
    extensionCommands.push(msg.payload.action);
    console.log(`  [extension] <- ${msg.payload.action}`);

    let result = {};
    if (msg.payload.action === 'navigate') {
      result = {
        url: 'https://example.com/pricing',
        title: 'Pricing — Acme Cloud',
        snapshot: {
          url: 'https://example.com/pricing',
          title: 'Pricing — Acme Cloud',
          capturedAt: Date.now(),
          elements: [
            { ref: 'e1', role: 'heading', name: 'Pricing', tag: 'h1' },
            { ref: 'e2', role: 'link', name: 'Sign up', tag: 'a' },
          ],
        },
      };
    } else if (msg.payload.action === 'snapshot') {
      result = {
        url: 'https://example.com/pricing',
        title: 'Pricing — Acme Cloud',
        capturedAt: Date.now(),
        elements: [
          { ref: 'e1', role: 'heading', name: 'Pricing', tag: 'h1' },
          { ref: 'e2', role: 'link', name: 'Sign up', tag: 'a' },
        ],
        text: 'Pricing. Pro tier $29 per month. Enterprise custom pricing.',
      };
    }

    socket.send(
      JSON.stringify({
        v: '1.0.0',
        type: 'browser.result',
        id: msg.id,
        payload: { ok: true, result },
      }),
    );
  });
}

/* 3. Drive a real task through the real daemon ---------------------------- */

function waitForHealth(port, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) return resolve(await res.json());
      } catch {
        /* not up yet */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('daemon did not start'));
      setTimeout(attempt, 250);
    };
    void attempt();
  });
}

const results = { pass: 0, fail: 0 };
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    results.pass++;
  } else {
    console.log(`  ✗ ${name} ${detail}`);
    results.fail++;
  }
}

async function main() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log('\n▸ Mock model server');
  await new Promise((r) => modelServer.listen(MODEL_PORT, '127.0.0.1', r));
  console.log(`  :${MODEL_PORT}`);

  console.log('\n▸ Mock extension bridge');
  const configPath = path.join(OUT_DIR, 'config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      activeProvider: 'mock',
      outputDir: OUT_DIR,
      dataDir: path.join(OUT_DIR, 'data'),
      bridgePort: BRIDGE_PORT,
      providers: [
        {
          id: 'mock',
          kind: 'openai-compatible',
          label: 'Mock Model',
          baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`,
          model: 'mock-model',
          apiKey: 'test',
        },
      ],
    }),
  );

  console.log('\n▸ Launching the real Celeste daemon');
  const child = spawn(
    process.execPath,
    [
      path.join(REPO, 'apps/cli/dist/index.js'),
      'serve',
      '--config',
      configPath,
      '--port',
      String(API_PORT),
      '--bridge-port',
      String(BRIDGE_PORT),
      '--output',
      OUT_DIR,
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (d) => process.stdout.write(`  [daemon] ${d.toString()}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [stderr] ${d.toString()}`));

  const cleanup = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  const health = await waitForHealth(API_PORT);
  check('daemon reports healthy', health.ok === true);

  console.log('\n▸ Connecting the mock extension to the daemon bridge');
  const socket = await connectExtension();
  handleExtension(socket);
  // Give the daemon a moment to register the connection.
  await new Promise((r) => setTimeout(r, 800));
  const health2 = await (await fetch(`http://127.0.0.1:${API_PORT}/api/health`)).json();
  check('daemon sees the extension connected', health2.extensionConnected === true);

  console.log('\n▸ Creating a task via the API');
  const created = await (
    await fetch(`http://127.0.0.1:${API_PORT}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Research the Acme Cloud pricing and write a report',
        autoApprove: true,
        outputDir: OUT_DIR,
      }),
    })
  ).json();
  const taskId = created.task.id;
  check('task created', Boolean(taskId));

  // Poll until the task reaches a terminal state.
  let task = created.task;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const detail = await (
      await fetch(`http://127.0.0.1:${API_PORT}/api/sessions/${taskId}`)
    ).json();
    task = detail.task;
    if (['completed', 'failed', 'cancelled'].includes(task.status)) break;
  }

  console.log('\n▸ Pipeline assertions');
  check('task completed', task.status === 'completed', `status=${task.status} err=${task.error?.message ?? ''}`);
  check('model was called at least 3 times', modelCalls.length >= 3, `got ${modelCalls.length}`);
  check(
    'planner used the planner prompt',
    modelCalls.some((c) => c.messages.some((m) => m.role === 'system' && String(m.content).includes('planner'))),
  );
  check(
    'tools were advertised to the model',
    modelCalls.some((c) => Array.isArray(c.tools) && c.tools.length > 0),
  );
  check(
    'browser tool names were advertised',
    modelCalls.some((c) => (c.tools ?? []).some((t) => t.function?.name === 'browser_navigate')),
  );
  check('extension received browser_navigate', extensionCommands.includes('navigate'), extensionCommands.join(','));
  check('extension received browser_snapshot', extensionCommands.includes('snapshot'), extensionCommands.join(','));
  check('plan has 3 steps', task.plan?.length === 3, `got ${task.plan?.length}`);
  check('all plan steps done', task.plan?.every((s) => s.status === 'done'));
  check('task recorded 1 artefact', task.artifacts?.length === 1, `got ${task.artifacts?.length}`);

  const docxPath = path.join(OUT_DIR, 'pricing-report.docx');
  const exists = await fs.access(docxPath).then(() => true).catch(() => false);
  check('the .docx artefact was written', exists);
  if (exists) {
    const buf = await fs.readFile(docxPath);
    check('the .docx is a real zip container', buf.subarray(0, 4).toString('hex') === '504b0304');
    check('the .docx has content', buf.length > 1000, `${buf.length} bytes`);
    const listing = execSync(`unzip -l ${docxPath}`).toString();
    check('word/document.xml is present', listing.includes('word/document.xml'));
    const xml = execSync(`unzip -p ${docxPath} word/document.xml`).toString();
    check('the report text is inside the document', xml.includes('Acme Cloud'));
    check('the table data is inside the document', xml.includes('Enterprise'));
  }

  console.log(`\n${results.pass} passed, ${results.fail} failed\n`);

  cleanup();
  modelServer.close();
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E failed:', err);
  process.exit(1);
});
