# Celeste (codename **Boba**)

> An open-source AI browser agent that operates **your real, already-logged-in browser** — then does what you actually asked for: research across sites, fill in forms, and produce real DOCX / PDF / XLSX / PPTX files.

Celeste is not a chatbot that summarises web pages. It is an agent that drives a browser,
verifies what happened, recovers when it fails, and hands you finished files.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Celeste UI (React)  ·  MCP bridge for any coding agent              │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│  Celeste Daemon (Node/TS)                                             │
│  ├─ Agent runtime   plan → act → observe → verify → recover          │
│  ├─ Universal Model Gateway   OpenAI · Anthropic · Gemini · Ollama · │
│  │                            OpenRouter · Groq · any OpenAI-compat │
│  ├─ Tool registry   browser · files · documents · memory             │
│  ├─ Guardrails      prompt-injection defence · approval gate         │
│  └─ Browser bridge  WebSocket ↔ extension                            │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  ws://127.0.0.1:9223
┌───────────────────────────────▼──────────────────────────────────────┐
│  Celeste Extension (Manifest V3)  →  Brave / Chromium                │
│  real profile, real session, real cookies, real you                  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Why this exists

Commercial browser agents ("operators") have three structural problems that Celeste is
built to remove:

1. **They use a sterile, logged-out window.** Real tasks die at the 2FA wall.
   Celeste drives *your* browser with *your* session.
2. **They lock you into their model.** Celeste ships a Universal Model Gateway:
   swap between a local Ollama model and a frontier cloud model with one toggle.
3. **They phone home.** Celeste runs entirely on your machine. No telemetry.

---

## Install

```bash
git clone <this-repo> celeste && cd celeste
pnpm install
pnpm build
```

### 1. Load the extension

```bash
pnpm build:ext
```

Then in Brave/Chromium: `brave://extensions` → enable **Developer mode** → **Load unpacked** →
select `packages/extension/dist`.

### 2. Pick a model

Celeste finds providers automatically from your environment:

```bash
export OPENROUTER_API_KEY=sk-...     # or OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY
export OLLAMA_HOST=http://localhost:11434
```

or add one explicitly:

```bash
pnpm --filter @celeste/cli start add-provider '{
  "id": "my-proxy",
  "kind": "openai-compatible",
  "baseUrl": "http://localhost:8000/v1",
  "model": "my-model",
  "apiKeyEnv": "MY_PROXY_KEY"
}'

pnpm --filter @celeste/cli start use my-proxy
```

### 3. Run

```bash
# One-shot task
pnpm celeste run "Research the top three open-source game engines and write a comparison spreadsheet"

# Or the daemon + UI
pnpm celeste serve
pnpm dev:ui          # http://localhost:5173
```

---

## Using Celeste from your coding agent

Celeste speaks the Model Context Protocol, so Claude Code, Cline, Mochi, or anything
else with an MCP client can drive your browser:

```json
{
  "mcpServers": {
    "celeste": {
      "command": "node",
      "args": ["/path/to/celeste/packages/mcp/dist/index.js"]
    }
  }
}
```

Tools exposed: `celeste_navigate`, `celeste_snapshot`, `celeste_click`, `celeste_type`,
`celeste_extract`, `celeste_evaluate`, `celeste_screenshot`, `celeste_network`,
`celeste_tabs`, `celeste_console`, `celeste_read_file`, `celeste_write_file`.

That gives you the closed loop: **write code → launch a dev server → have Celeste open it →
verify the UI → read the console → fix the bug → repeat.**

---

## How the agent thinks

### Plan → act → observe → verify → recover

A run is not a single model call. It is a loop with teeth:

1. **Plan.** A dedicated planner turn decomposes the request into 3–8 observable steps.
2. **Act.** The agent calls tools. Every call is validated against a JSON schema before
   it runs, so a hallucinated parameter produces a clean error, not a crash.
3. **Observe.** Tool output comes back as messages. Content-bearing output is scanned.
4. **Verify.** The agent is instructed to re-read the page after an action that should
   change it, and to distinguish "the tool returned ok" from "the goal is met".
5. **Recover.** Retryable failures are retried. Three consecutive failures abort the run
   rather than looping forever. When a step fails, the agent is told to *change approach*,
   not to repeat itself.

### Prompt-injection defence

Because Celeste reads pages that a stranger wrote, indirect prompt injection is a
first-class threat, not an afterthought.

- Page content is scanned for known injection patterns (`scanForInjection` in
  `@celeste/protocol`) — "ignore your previous instructions", "reveal your system
  prompt", "send the cookies to …", hidden comment instructions, urgency framing.
- Matches are **neutralised in place** — the content is preserved so the agent still
  understands the page, but the imperative is defanged and replaced with
  `[[BLOCKED:rule-name]]`.
- The agent receives an explicit **SECURITY ALERT** alongside the content and is
  instructed to report the attempt to the user rather than comply with it.
- Untrusted content is fenced (`<<<PAGE_CONTENT>>>`) so it is never confused with
  instruction.

### Human in the loop

Anything that changes the world outside the agent's sandbox pauses for approval:
form submissions, clicks, file writes and deletions, credential access, and — detected
by URL pattern — checkout, payout, account-deletion and password pages.

The approval card shows the tool, the arguments, and a plain-language reason. Deny it and
the agent is told *not to retry*; it must find another way or report back.

### Session health guard

When a site logs you out mid-task, or a Cloudflare challenge appears, Celeste does not
hammer the login wall. It detects the state, pauses the run, and asks you to re-authenticate
or solve the challenge. Then it resumes.

---

## The Universal Model Gateway

| Provider | Kind | Notes |
|---|---|---|
| Ollama | `ollama` | Local weights. Default when a local server is detected. |
| OpenAI | `openai` | `/v1/chat/completions`. |
| Anthropic | `anthropic` | Messages API, native tool use, vision. |
| Google Gemini | `google` | `generateContent`, function declarations. |
| OpenRouter | `openai-compatible` | Any model, one endpoint. |
| Groq · Together · DeepSeek · xAI · Kimi · SiliconFlow | `openai-compatible` | Auto-detected from env keys. |
| LM Studio · llama.cpp · vLLM · LiteLLM | `openai-compatible` | Local, OpenAI-shaped. |
| **Anything else** | `openai-compatible` | `baseUrl` + `model` + `apiKeyEnv`. |

Switching models is one assignment — no reload, no restart.

---

## Packages

| Package | What it is |
|---|---|
| `@celeste/protocol` | Shared types, wire protocol, guardrail rules. The contract everything agrees on. |
| `@celeste/gateway` | Universal Model Gateway — provider adapters, config, health. |
| `@celeste/core` | Agent runtime, planner, approval gate, session guard, browser bridge, HTTP/WS daemon. |
| `@celeste/tools` | Tool registry + browser / file / document / memory tools. |
| `@celeste/documents` | DOCX · PDF · XLSX · PPTX · Markdown · HTML · CSV renderers. |
| `@celeste/extension` | Manifest V3 extension: DOM actuation, snapshots, network capture, challenge detection. |
| `@celeste/mcp` | MCP server exposing browser primitives to any coding agent. |
| `@celeste/ui` | React desktop-class client. |
| `@celeste/cli` | `celeste` command line interface. |

---

## CLI

```
celeste run <prompt...>       Run a task and stream the result
celeste serve                Start the daemon (HTTP API + browser bridge)
celeste models               List providers and models
celeste use <provider-id>    Switch the active provider
celeste add-provider <json>  Add or update a provider
celeste config               Show the resolved configuration
celeste health               Check the daemon and the extension
celeste mcp                  Run the MCP server on stdio
```

---

## Privacy

- Everything runs locally. There is no analytics endpoint, no crash reporter, no telemetry.
- The only outbound requests are the ones **you** configure: your model provider, and the
  websites the agent is asked to visit.
- Browsing history never leaves the machine except inside the prompt you send to your own
  model provider — which is exactly the trade every LLM tool makes, and exactly why you
  can point Celeste at a local Ollama model instead.

---

## Licence

Apache-2.0.
