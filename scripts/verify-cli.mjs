/**
 * Verifies the `celeste run` CLI path end to end: a mock model and a mock
 * browser extension drive a real task that writes a real file.
 *
 * Run: node scripts/verify-cli.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(REPO, '.artifacts', 'cli');
const MODEL_PORT = 8898;
const BRIDGE_PORT = 9296;

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
  mkdirSync(OUT, { recursive: true });

  // ── Mock model ──────────────────────────────────────────────────────────
  let turn = 0;
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const isPlanner = body.messages.some(
      (m) => m.role === 'system' && String(m.content).includes('planner'),
    );
    let message;
    if (isPlanner) {
      message = {
        role: 'assistant',
        content: JSON.stringify({ steps: [{ description: 'Write a summary' }] }),
      };
    } else {
      turn++;
      message =
        turn === 1
          ? {
              role: 'assistant',
              content: 'Writing.',
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {
                    name: 'document_create',
                    arguments: JSON.stringify({
                      kind: 'md',
                      title: 'Summary',
                      fileName: 'summary.md',
                      spec: {
                        title: 'Summary',
                        blocks: [{ type: 'paragraph', text: 'It works.' }],
                      },
                    }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'Done — summary.md written.' };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise((r) => model.listen(MODEL_PORT, '127.0.0.1', r));

  // ── Config ──────────────────────────────────────────────────────────────
  const configPath = path.join(OUT, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      activeProvider: 'mock',
      outputDir: OUT,
      dataDir: path.join(OUT, 'data'),
      bridgePort: BRIDGE_PORT,
      providers: [
        {
          id: 'mock',
          kind: 'openai-compatible',
          label: 'Mock',
          baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`,
          model: 'mock-model',
          apiKey: 'test',
        },
      ],
    }),
  );

  // ── Run the CLI ─────────────────────────────────────────────────────────
  const child = spawn(
    process.execPath,
    [
      path.join(REPO, 'apps/cli/dist/index.js'),
      'run',
      'Write a summary',
      '--config',
      configPath,
      '--port',
      '9196',
      '--bridge-port',
      String(BRIDGE_PORT),
      '--output',
      OUT,
      '--auto-approve',
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += d.toString();
  });
  child.stderr.on('data', (d) => {
    err += d.toString();
  });

  // Connect the mock extension once the daemon's bridge is listening.
  let ext;
  for (let i = 0; i < 100; i++) {
    try {
      ext = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
      await new Promise((resolve, reject) => {
        ext.on('open', resolve);
        ext.on('error', reject);
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!ext) throw new Error('the mock extension could not connect');
  ext.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'browser.command') {
      ext.send(
        JSON.stringify({
          v: '1.0.0',
          type: 'browser.result',
          id: msg.id,
          payload: { ok: true, result: {} },
        }),
      );
    }
  });

  const code = await new Promise((resolve) => child.on('exit', resolve));

  // ── Assertions ──────────────────────────────────────────────────────────
  console.log('\n▸ CLI run path');
  check('the CLI exited cleanly', code === 0, `exit=${code} ${err.slice(0, 200)}`);
  check('the CLI printed the plan', out.includes('Plan:'));
  check('the CLI printed the tool call', out.includes('document_create'));
  check('the CLI printed the artefact path', out.includes('summary.md'));
  check('the CLI reported completion', out.includes('Task completed'));

  const md = path.join(OUT, 'summary.md');
  check('the markdown file was written', existsSync(md));
  check(
    'the markdown file has the expected content',
    existsSync(md) && readFileSync(md, 'utf8').includes('It works.'),
  );

  ext.close();
  model.close();

  console.log(`\n${results.pass} passed, ${results.fail} failed\n`);
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('CLI verification failed:', err);
  process.exit(1);
});
