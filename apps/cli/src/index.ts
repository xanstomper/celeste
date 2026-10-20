#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { startDaemon } from '@celeste/core';
import { loadConfig, saveConfig } from '@celeste/gateway';
import type { ProviderConfig } from '@celeste/gateway';
import { browse } from './browse.js';

const VERSION = '0.1.0';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const [key, inlineValue] = arg.slice(2).split('=', 2);
      const name = key!;
      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
      } else if (rest[i + 1] && !rest[i + 1]!.startsWith('-')) {
        flags[name] = rest[++i]!;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

/* -------------------------------------------------------------------------- */
/* Pretty output helpers                                                      */
/* -------------------------------------------------------------------------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, text: string): string =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

const bold = (t: string): string => paint('1', t);
const dim = (t: string): string => paint('2', t);
const cyan = (t: string): string => paint('36', t);
const green = (t: string): string => paint('32', t);
const yellow = (t: string): string => paint('33', t);
const red = (t: string): string => paint('31', t);
const magenta = (t: string): string => paint('35', t);

function print(text = ''): void {
  process.stdout.write(`${text}\n`);
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

const HELP = `
${bold('Celeste')} ${dim(`v${VERSION}`)} — ${bold('an open-source AI browser agent')}

${bold('USAGE')}
  celeste <command> [options]

${bold('COMMANDS')}
  ${cyan('run')} <prompt...>       Run a task with the agent and stream the result
  ${cyan('browse')} [url...]        Open a visible browser with the Celeste agent panel
  ${cyan('serve')}                Start the daemon (HTTP API + browser bridge)
  ${cyan('models')}               List configured providers and models
  ${cyan('use')} <provider-id>    Switch the active provider
  ${cyan('add-provider')} <json>  Add or update a provider in the config file
  ${cyan('config')}               Show the resolved configuration
  ${cyan('health')}               Check the daemon and the browser extension
  ${cyan('mcp')}                  Run the MCP server on stdio
  ${cyan('help')}                 Show this message

${bold('OPTIONS')}
  --provider <id>       Provider to use for this run
  --port <n>            Daemon HTTP port (default 9126)
  --bridge-port <n>     Browser bridge port (default 9223)
  --output <dir>        Directory for generated files
  --config <file>       Path to a config file
  --auto-approve        Skip human approval prompts (demo mode)
  --max-steps <n>       Maximum agent steps per task
  --json                Machine readable output
  --browser <id>        Browser for \`browse\`: brave | chrome | chromium
  --profile <dir>       Profile directory for \`browse\`
  --debug-port <n>      DevTools port used to open the panel (default 9222)
  --no-panel            Do not open the agent panel automatically
  --real-profile        Use your everyday browser profile (with its logins)

${bold('EXAMPLES')}
  celeste run "Find the pricing page for the top three GPU providers and summarise it"
  celeste browse https://news.ycombinator.com
  celeste browse --real-profile github.com
  celeste serve --port 9126
  celeste models
  celeste add-provider '{"id":"my-llm","kind":"openai-compatible","baseUrl":"http://localhost:8000/v1","model":"my-model"}'
`;

async function cmdRun(args: ParsedArgs): Promise<number> {
  const prompt = args.positional.join(' ').trim();
  if (!prompt) {
    print(red('A prompt is required. Example: celeste run "open example.com"'));
    return 1;
  }

  const runtime = await startDaemon({
    port: Number(args.flags.port ?? 9126),
    bridgePort: Number(args.flags['bridge-port'] ?? 9223),
    configPath: args.flags.config ? String(args.flags.config) : undefined,
    providerId: args.flags.provider ? String(args.flags.provider) : undefined,
    outputDir: args.flags.output ? String(args.flags.output) : undefined,
    autoApprove: Boolean(args.flags['auto-approve']),
    maxSteps: args.flags['max-steps'] ? Number(args.flags['max-steps']) : undefined,
    serve: false,
    serveBridge: true,
  });

  const activeId = runtime.gateway.getActiveId();
  print(dim(`› provider: ${activeId ?? 'none'}   extension: ${runtime.bridge.isConnected ? 'connected' : 'not connected'}`));
  print('');

  const task = runtime.store.create(prompt.slice(0, 120));
  runtime.store.appendMessage(task.id, { role: 'user', content: prompt });

  runtime.bus.subscribe((event) => {
    switch (event.type) {
      case 'task.plan':
        print(bold('\nPlan:'));
        for (const step of event.plan) {
          const marker =
            step.status === 'done' ? green('✓') : step.status === 'active' ? magenta('▸') : dim('·');
          print(`  ${marker} ${step.description}`);
        }
        print('');
        break;

      case 'task.tool.start':
        print(`${cyan('●')} ${bold(event.toolName)} ${dim(JSON.stringify(event.arguments).slice(0, 120))}`);
        break;

      case 'task.tool.end':
        print(
          event.ok
            ? `  ${green('✓')} ${event.summary} ${dim(`(${event.durationMs}ms)`)}`
            : `  ${red('✗')} ${event.summary}`,
        );
        break;

      case 'task.message':
        if (event.message.role === 'assistant') {
          const text =
            typeof event.message.content === 'string'
              ? event.message.content
              : event.message.content
                  .filter((p) => p.type === 'text')
                  .map((p) => (p as { text: string }).text)
                  .join('');
          if (text.trim()) {
            print('');
            print(text);
            print('');
          }
        }
        break;

      case 'task.approval':
        print(yellow(`⚠ approval needed: ${event.request.toolName} — ${event.request.reason}`));
        break;

      case 'task.human':
        print(yellow(`⚠ ${event.reason}`));
        break;

      case 'task.artifact':
        print(green(`📄`) + ` ${event.artifact.path} ${dim(`(${event.artifact.bytes} bytes)`)}`);
        break;

      case 'task.done':
        print('');
        print(
          event.status === 'completed'
            ? green(bold('✓ Task completed.'))
            : event.status === 'cancelled'
              ? yellow(bold('— Task cancelled.'))
              : red(bold('✗ Task failed.')),
        );
        break;

      default:
        break;
    }
  });

  await runtime.agent.run(task.id);
  await runtime.stop();

  const final = runtime.store.get(task.id);
  return final?.status === 'completed' ? 0 : 1;
}

async function cmdBrowse(args: ParsedArgs): Promise<number> {
  const urls = args.positional.filter((u) => !u.startsWith('-'));
  const result = await browse({
    urls,
    browser: args.flags.browser ? String(args.flags.browser) : undefined,
    profileDir: args.flags.profile ? String(args.flags.profile) : undefined,
    useRealProfile: Boolean(args.flags['real-profile']),
    debugPort: args.flags['debug-port'] ? Number(args.flags['debug-port']) : undefined,
    noPanel: Boolean(args.flags['no-panel']),
  });

  print(bold('\nCeleste browser\n'));
  print(`  Browser    ${result.browser.label}`);
  print(`  Profile    ${result.profileDir}`);
  print(`  Extension  ${result.extensionDir ?? yellow('not built — run `pnpm build:ext`')}`);
  print('');
  if (result.panelOpened) {
    print(green('  ✓ The agent panel is open, docked to the right of the page.'));
  } else {
    print(yellow('  ! The panel could not be opened automatically.'));
    print(dim('    Click the Celeste icon in the toolbar, or press Ctrl+Shift+K.'));
  }
  print('');
  print(dim('  The daemon must be running:  celeste serve'));
  print(dim('  Ask the agent from the panel on the right.'));
  print('');
  return 0;
}

async function cmdServe(args: ParsedArgs): Promise<number> {
  const runtime = await startDaemon({
    port: Number(args.flags.port ?? 9126),
    bridgePort: Number(args.flags['bridge-port'] ?? 9223),
    configPath: args.flags.config ? String(args.flags.config) : undefined,
    providerId: args.flags.provider ? String(args.flags.provider) : undefined,
    outputDir: args.flags.output ? String(args.flags.output) : undefined,
  });

  print(bold('Celeste daemon running'));
  print(`  API     ${cyan(`http://127.0.0.1:${Number(args.flags.port ?? 9126)}`)}`);
  print(`  Bridge  ${cyan(`ws://127.0.0.1:${Number(args.flags['bridge-port'] ?? 9223)}/extension`)}`);
  print(`  Output  ${runtime.config.outputDir}`);
  print(`  Model   ${runtime.gateway.getActiveId() ?? 'none'}`);
  print('');
  print(dim('Press Ctrl+C to stop.'));

  const shutdown = async () => {
    print('');
    print(dim('Shutting down…'));
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Keep the process alive.
  await new Promise(() => {});
  return 0;
}

async function cmdModels(args: ParsedArgs): Promise<number> {
  const config = await loadConfig(args.flags.config ? String(args.flags.config) : undefined);
  const activeId = config.activeProvider;

  if (args.flags.json) {
    print(JSON.stringify(config.providers, null, 2));
    return 0;
  }

  print(bold('\nConfigured providers\n'));
  for (const provider of config.providers) {
    const active = provider.id === activeId;
    const key = provider.apiKey
      ? green('key ✓')
      : provider.apiKeyEnv && process.env[provider.apiKeyEnv]
        ? green('key ✓')
        : dim('key —');

    print(
      `${active ? green('●') : dim('○')} ${bold(provider.id.padEnd(14))} ${dim(provider.kind.padEnd(18))} ${provider.model}`,
    );
    print(`   ${dim('base:')} ${provider.baseUrl ?? '(default)'}   ${key}  ${dim(provider.source ?? 'config')}`);
  }
  print('');
  print(dim(`Active: ${activeId ?? 'none'}`));
  print('');
  return 0;
}

async function cmdUse(args: ParsedArgs): Promise<number> {
  const id = args.positional[0];
  if (!id) {
    print(red('A provider id is required.'));
    return 1;
  }

  const config = await loadConfig(args.flags.config ? String(args.flags.config) : undefined);
  const exists = config.providers.some((p) => p.id === id);
  if (!exists) {
    print(red(`Unknown provider "${id}".`));
    print(dim(`Known: ${config.providers.map((p) => p.id).join(', ')}`));
    return 1;
  }

  config.activeProvider = id;
  const file = await saveConfig(config, args.flags.config ? String(args.flags.config) : undefined);
  print(green(`✓ Active provider set to ${bold(id)}`));
  print(dim(file));
  return 0;
}

async function cmdAddProvider(args: ParsedArgs): Promise<number> {
  const json = args.positional.join(' ');
  if (!json) {
    print(red('A provider JSON object is required.'));
    return 1;
  }

  let provider: ProviderConfig;
  try {
    provider = JSON.parse(json) as ProviderConfig;
  } catch {
    print(red('That is not valid JSON.'));
    return 1;
  }

  if (!provider.id || !provider.kind || !provider.model) {
    print(red('The provider needs at least "id", "kind" and "model".'));
    return 1;
  }

  const config = await loadConfig(args.flags.config ? String(args.flags.config) : undefined);
  const index = config.providers.findIndex((p) => p.id === provider.id);
  if (index === -1) config.providers.push({ ...provider, source: 'config' });
  else config.providers[index] = { ...config.providers[index], ...provider, source: 'config' };

  const file = await saveConfig(config, args.flags.config ? String(args.flags.config) : undefined);
  print(green(`✓ Provider "${provider.id}" saved`));
  print(dim(file));
  return 0;
}

async function cmdConfig(args: ParsedArgs): Promise<number> {
  const config = await loadConfig(args.flags.config ? String(args.flags.config) : undefined);
  if (args.flags.json) {
    print(JSON.stringify(config, null, 2));
    return 0;
  }
  print(bold('Resolved configuration\n'));
  print(`  active provider  ${config.activeProvider ?? '(none)'}`);
  print(`  providers        ${config.providers.length}`);
  print(`  output dir       ${config.outputDir}`);
  print(`  data dir         ${config.dataDir}`);
  print(`  bridge port      ${config.bridgePort}`);
  print(`  max steps        ${config.maxSteps}`);
  print('');
  return 0;
}

async function cmdHealth(args: ParsedArgs): Promise<number> {
  const port = Number(args.flags.port ?? 9126);

  // Daemon health.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const health = (await res.json()) as Record<string, unknown>;
    print(`${green('✓')} daemon      ${cyan(`http://127.0.0.1:${port}`)}`);
    print(`  model     ${health.activeProvider} / ${health.activeModel}`);
    print(`  uptime    ${health.uptimeSeconds}s`);
  } catch {
    print(`${red('✗')} daemon      not running on port ${port}`);
  }

  // Extension health — connect to the bridge port.
  try {
    const { WebSocket } = await import('ws');
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${Number(args.flags['bridge-port'] ?? 9223)}`);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('timeout'));
      }, 3000);
      socket.on('open', () => {
        clearTimeout(timer);
        socket.close();
        resolve();
      });
      socket.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    print(`${green('✓')} extension  connected`);
  } catch {
    print(`${yellow('!')} extension  not connected`);
  }

  print('');
  return 0;
}

function cmdMcp(): number {
  const child = spawn(process.execPath, [
    path.join(import.meta.dirname, '..', '..', '..', 'packages', 'mcp', 'dist', 'index.js'),
  ], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'run':
    case 'r':
      process.exit(await cmdRun(args));
      break;
    case 'browse':
    case 'browser':
      process.exit(await cmdBrowse(args));
      break;
    case 'serve':
    case 'daemon':
      process.exit(await cmdServe(args));
      break;
    case 'models':
      process.exit(await cmdModels(args));
      break;
    case 'use':
      process.exit(await cmdUse(args));
      break;
    case 'add-provider':
      process.exit(await cmdAddProvider(args));
      break;
    case 'config':
      process.exit(await cmdConfig(args));
      break;
    case 'health':
      process.exit(await cmdHealth(args));
      break;
    case 'mcp':
      cmdMcp();
      break;
    case 'version':
    case '--version':
      print(VERSION);
      break;
    case 'help':
    case '--help':
    case '-h':
      print(HELP);
      break;
    default:
      print(red(`Unknown command "${args.command}"`));
      print(HELP);
      process.exit(1);
  }
}

// Make sure the output directory exists for generated artefacts.
await fs.mkdir(process.env.HOME ? path.join(process.env.HOME, 'Documents', 'Celeste') : process.cwd(), {
  recursive: true,
});

main().catch((err: unknown) => {
  print(red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
