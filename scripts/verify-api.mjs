/**
 * Verifies the daemon's HTTP/SSE contract — the exact surface the React
 * client and any external consumer depend on.
 *
 * Run: node scripts/verify-api.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const API_PORT = 9197;
const BRIDGE_PORT = 9297;

const results = { pass: 0, fail: 0 };
const log = [];

function check(name, condition, detail = '') {
  if (condition) {
    log.push(`  ✓ ${name}`);
    results.pass++;
  } else {
    log.push(`  ✗ ${name} ${detail}`);
    results.fail++;
  }
}

async function waitForHealth(port, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error('daemon did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main() {
  const child = spawn(
    process.execPath,
    [
      path.join(REPO, 'apps/cli/dist/index.js'),
      'serve',
      '--port',
      String(API_PORT),
      '--bridge-port',
      String(BRIDGE_PORT),
      '--output',
      path.join(REPO, '.artifacts', 'api'),
    ],
    { cwd: REPO, stdio: 'ignore' },
  );
  process.on('exit', () => child.kill('SIGKILL'));

  const base = `http://127.0.0.1:${API_PORT}`;

  try {
    const health = await waitForHealth(API_PORT);
    log.push('▸ Health');
    check('health.ok is true', health.ok === true);
    check('health reports an apiVersion', typeof health.apiVersion === 'string');
    check('health reports extensionConnected', typeof health.extensionConnected === 'boolean');
    check('health reports a provider count', health.providerCount > 0);

    log.push('\n▸ Providers');
    const providers = await (await fetch(`${base}/api/providers`)).json();
    check('providers list is an array', Array.isArray(providers.providers));
    check('exactly one provider is active', providers.providers.filter((p) => p.active).length === 1);
    check('active provider has a model', typeof providers.providers.find((p) => p.active)?.model === 'string');

    const target = providers.providers.find((p) => !p.active);
    if (target) {
      const switched = await (
        await fetch(`${base}/api/providers/active`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: target.id }),
        })
      ).json();
      check('provider switch returns the new active provider', switched.active?.id === target.id);
    }

    log.push('\n▸ Sessions');
    const created = await (
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello', autoApprove: true }),
      })
    ).json();
    check('session creation returns a task', Boolean(created.task?.id));
    check('the task has an id', typeof created.task?.id === 'string');
    check('the task starts queued or running', ['queued', 'running'].includes(created.task?.status));

    const id = created.task.id;

    const detail = await (await fetch(`${base}/api/sessions/${id}`)).json();
    check('session detail returns the task', detail.task?.id === id);

    const missing = await fetch(`${base}/api/sessions/does-not-exist`);
    check('an unknown session 404s', missing.status === 404);

    const badBody = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    check('a malformed body is rejected', badBody.status === 400);

    log.push('\n▸ Approvals');
    const badApproval = await fetch(`${base}/api/sessions/${id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'nope', decision: 'approve' }),
    });
    check('approving an unknown request 404s', badApproval.status === 404);

    log.push('\n▸ SSE stream');
    const sse = await fetch(`${base}/api/sessions/${id}/events`);
    check('SSE responds 200', sse.status === 200);
    check('SSE sets the right content-type', sse.headers.get('content-type')?.includes('text/event-stream'));
    check('SSE disables caching', sse.headers.get('cache-control')?.includes('no-cache'));

    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !buffer.includes('data:')) {
      const race = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: true }), 400)),
      ]);
      if (race.done) break;
      buffer += decoder.decode(race.value, { stream: true });
    }
    check('SSE delivers at least one event frame', buffer.includes('data:'));
    const frame = buffer.split('\n').find((l) => l.startsWith('data:'));
    if (frame) {
      try {
        const parsed = JSON.parse(frame.slice(5));
        check('SSE frames are valid JSON', typeof parsed.type === 'string');
      } catch {
        check('SSE frames are valid JSON', false);
      }
    }
    await reader.cancel().catch(() => {});

    log.push('\n▸ Artifacts & messaging');
    const artifacts = await (await fetch(`${base}/api/artifacts`)).json();
    check('artifacts endpoint returns an array', Array.isArray(artifacts.artifacts));

    const sent = await fetch(`${base}/api/sessions/${id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'a follow-up' }),
    });
    check('a follow-up message is accepted', sent.status === 200);

    const empty = await fetch(`${base}/api/sessions/${id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '  ' }),
    });
    check('an empty message is rejected', empty.status === 400);

    const cancel = await fetch(`${base}/api/sessions/${id}/cancel`, { method: 'POST' });
    check('cancel is accepted', cancel.status === 200);

    log.push('\n▸ Unknown routes');
    const nope = await fetch(`${base}/api/nope`);
    check('unknown routes 404', nope.status === 404);
  } finally {
    child.kill('SIGKILL');
  }

  log.unshift(`\n${results.pass} passed, ${results.fail} failed\n`);
  writeFileSync(path.join(REPO, '.artifacts', 'verify-api.log'), log.join('\n'));
  console.log(log.join('\n'));
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('API verification failed:', err);
  process.exit(1);
});
