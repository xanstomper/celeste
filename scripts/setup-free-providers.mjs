#!/usr/bin/env node
/**
 * Configures Celeste with the free inference providers that actually work on
 * this machine.
 *
 * It probes each candidate endpoint for reachability and native tool-calling
 * support, then writes ~/.celeste/config.json and ~/.celeste/.env containing
 * only the providers that passed.
 *
 * Run: node scripts/setup-free-providers.mjs
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const HOME = homedir();
const CELESTE_DIR = path.join(HOME, '.celeste');
const CONFIG_PATH = path.join(CELESTE_DIR, 'config.json');
const ENV_PATH = path.join(CELESTE_DIR, '.env');

const dim = (t) => `\u001b[2m${t}\u001b[0m`;
const green = (t) => `\u001b[32m${t}\u001b[0m`;
const red = (t) => `\u001b[31m${t}\u001b[0m`;
const bold = (t) => `\u001b[1m${t}\u001b[0m`;
const cyan = (t) => `\u001b[36m${t}\u001b[0m`;

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

/** Pulls KEY=value pairs out of env files without exporting them globally. */
function readEnvFiles(files) {
  const found = {};
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = (m[2] ?? '').trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v && found[m[1]] === undefined) found[m[1]] = v;
    }
  }
  return found;
}

const envFiles = [
  path.join(CELESTE_DIR, '.env'),
  path.join(HOME, '.hermes', '.env'),
  path.join(HOME, '.bashrc'),
  path.join(HOME, '.profile'),
];
const keys = readEnvFiles(envFiles);
for (const [k, v] of Object.entries(process.env)) if (v) keys[k] ??= v;

/* -------------------------------------------------------------------------- */
/* Candidates                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every free provider we know how to reach. `keyEnv` names the variable to
 * read the credential from; `null` means the endpoint needs no credential.
 */
const CANDIDATES = [
  {
    id: 'silkroute',
    label: 'SilkRoute (local free router)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:8760/v1',
    keyEnv: 'SILKROUTE_API_KEY',
    mint: 'silk',
    models: ['sr-fast', 'sr-deepseek', 'sr-qwen', 'sr-glm', 'sr-code', 'sr-cloud'],
    preferredModel: 'sr-fast',
    note: 'Local router over free upstreams: Qwen 3.6 35B, GLM-5.3 Flash, DeepSeek V4 Flash.',
  },
  {
    id: 'freeinference',
    label: 'FreeInference.org',
    kind: 'openai-compatible',
    baseUrl: 'https://freeinference.org/v1',
    keyEnv: 'FREEINFERENCE_API_KEY',
    models: ['deepseek-v4-flash', 'qwen3.6-35b', 'glm-5.3-flash', 'kimi-k2.7-code'],
    preferredModel: 'deepseek-v4-flash',
    note: 'Free, no card. Chinese models only.',
  },
  {
    id: 'pollinations',
    label: 'Pollinations (no signup)',
    kind: 'openai-compatible',
    baseUrl: 'https://text.pollinations.ai/openai/v1',
    keyEnv: null,
    models: ['openai-fast'],
    preferredModel: 'openai-fast',
    note: 'No key at all. Rate limited.',
  },
  {
    id: 'ollama',
    label: 'Ollama (fully local)',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434',
    keyEnv: null,
    models: [],
    preferredModel: 'qwen3:1.7b',
    note: 'Runs on this machine. Unlimited, but only as smart as the weights.',
  },
];

/* -------------------------------------------------------------------------- */
/* Minting local keys                                                          */
/* -------------------------------------------------------------------------- */

/** Asks the local SilkRoute service for a fresh API key. */
async function mintSilkRouteKey() {
  const { spawn } = await import('node:child_process');
  // A unique name per mint: SilkRoute enforces a per-key daily token budget,
  // so a fresh key means a fresh budget.
  const name = `celeste-${Date.now().toString(36)}`;
  return new Promise((resolve) => {
    const child = spawn('python3', ['-m', 'silkroute', 'key', 'mint', name], {
      cwd: path.join(HOME, 'silkroute'),
      env: { ...process.env, PYTHONPATH: path.join(HOME, 'silkroute') },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const token = out.trim().split('\n').filter(Boolean).pop();
      resolve(token && token.startsWith('sr-') ? token : null);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Probing                                                                     */
/* -------------------------------------------------------------------------- */

const TOOL_SPEC = [
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Navigate to a URL',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
];

/**
 * Sends one tool-calling request. A provider only qualifies if the model
 * actually emits a tool call — anything less and the agent cannot work.
 */
async function probe(baseUrl, key, model, kind = 'openai-compatible') {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;

  // Ollama speaks its own dialect unless it was started with the OpenAI
  // compatibility shim enabled.
  const native = kind === 'ollama';
  const url = native ? `${baseUrl}/api/chat` : `${baseUrl}/chat/completions`;
  const body = native
    ? {
        model,
        messages: [{ role: 'user', content: 'Open https://example.com using the tool.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'browser_navigate',
              description: 'Navigate to a URL',
              parameters: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url'],
              },
            },
          },
        ],
        stream: false,
      }
    : {
        model,
        messages: [{ role: 'user', content: 'Open https://example.com using the tool.' }],
        tools: TOOL_SPEC,
        max_tokens: 150,
      };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, reason: `HTTP ${res.status} ${text.slice(0, 90)}` };
    }
    const data = await res.json();
    const calls = native
      ? data.message?.tool_calls
      : data.choices?.[0]?.message?.tool_calls;
    if (!calls?.length) {
      return { ok: false, reason: 'no tool call in response' };
    }
    return { ok: true, reason: `tool call → ${calls[0].function?.name}` };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Lists models exposed by an endpoint, when it exposes a listing at all. */
async function listModels(baseUrl, key) {
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  try {
    const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(bold('\nCeleste — free provider setup\n'));

  mkdirSync(CELESTE_DIR, { recursive: true });

  const envOut = [];
  const providers = [];
  let active = null;

  // The local router is preferred: it balances across several free upstreams
  // and falls back automatically when one is rate limited. The direct
  // endpoints are kept as fallbacks.
  const priority = ['silkroute', 'freeinference', 'pollinations', 'ollama'];
  const ordered = [...CANDIDATES].sort(
    (a, b) => priority.indexOf(a.id) - priority.indexOf(b.id),
  );

  for (const candidate of ordered) {
    let key = candidate.keyEnv ? keys[candidate.keyEnv] : null;

    // Mint a local key if the service offers one and we don't have it.
    if (!key && candidate.mint === 'silk') {
      console.log(dim(`  minting a SilkRoute key…`));
      key = await mintSilkRouteKey();
      if (key) {
        envOut.push(`SILKROUTE_API_KEY=${key}`);
        keys.SILKROUTE_API_KEY = key;
        console.log(green(`  minted a SilkRoute key`));
      }
    }

    if (candidate.keyEnv && !key) {
      console.log(dim(`  – ${candidate.id}: skipped (no ${candidate.keyEnv})`));
      continue;
    }

    // Work out which models to try.
    let models = candidate.models;
    if (models.length === 0) {
      const listed = await listModels(candidate.baseUrl, key);
      models = listed.length ? listed : [candidate.preferredModel];
    }

    let chosen = null;
    for (const model of models) {
      // Free endpoints cap concurrency; retry a couple of times with backoff
      // before declaring the model unusable.
      for (let attempt = 0; attempt < 3 && !chosen; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 4000 * attempt));
        const result = await probe(candidate.baseUrl, key, model, candidate.kind);
        if (result.ok) {
          chosen = model;
          console.log(green(`  ✓ ${candidate.id.padEnd(14)} ${model}`) + dim(` — ${result.reason}`));
        } else if (attempt === 2) {
          console.log(dim(`    ${candidate.id}/${model}: ${result.reason}`));
        }
      }
      if (chosen) break;
    }

    if (!chosen) {
      console.log(red(`  ✗ ${candidate.id.padEnd(14)} no working model`));
      continue;
    }

    const provider = {
      id: candidate.id,
      kind: candidate.kind,
      label: candidate.label,
      baseUrl: candidate.baseUrl,
      model: chosen,
      supportsTools: true,
      source: 'config',
    };
    if (candidate.keyEnv) provider.apiKeyEnv = candidate.keyEnv;
    providers.push(provider);

    if (!active) active = candidate.id;

    // Remember any credential we had to mint.
    if (candidate.keyEnv && keys[candidate.keyEnv] && !envOut.some((l) => l.startsWith(`${candidate.keyEnv}=`))) {
      envOut.push(`${candidate.keyEnv}=${keys[candidate.keyEnv]}`);
    }
  }

  if (providers.length === 0) {
    console.error(red('\n  No free provider responded. Check your network.\n'));
    process.exit(1);
  }

  const config = {
    activeProvider: active,
    outputDir: path.join(HOME, 'Documents', 'Celeste'),
    dataDir: path.join(CELESTE_DIR, 'data'),
    bridgePort: 9223,
    browserTimeoutMs: 30_000,
    maxSteps: 40,
    providers,
  };

  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  // Merge into the env file. A minted SilkRoute key replaces the previous one
  // (each key carries its own daily token budget), everything else is kept.
  let existing = '';
  if (existsSync(ENV_PATH)) existing = readFileSync(ENV_PATH, 'utf8');
  const lines = existing.split('\n').filter(Boolean);
  for (const entry of envOut) {
    const key = entry.split('=')[0];
    const index = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (index === -1) lines.push(entry);
    else lines[index] = entry;
  }
  writeFileSync(ENV_PATH, `${lines.join('\n')}\n`, 'utf8');

  console.log(bold('\n  Wrote:'));
  console.log(`   ${cyan(CONFIG_PATH)}`);
  console.log(`   ${cyan(ENV_PATH)}`);
  console.log(bold('\n  Providers:\n'));
  for (const p of providers) {
    console.log(
      `   ${p.id === active ? green('●') : dim('○')} ${bold(p.id.padEnd(14))} ${dim(p.model.padEnd(22))} ${dim(p.baseUrl)}`,
    );
  }
  console.log(`\n  Active: ${green(active)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
