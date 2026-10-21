# @celeste/ui

The Celeste desktop client — a local-first React + TypeScript UI for the
Celeste browser agent.

> Zero telemetry. Everything runs on your machine. Nothing leaves it without
> your explicit approval.

## Run it

```bash
pnpm --filter @celeste/ui dev      # http://localhost:5173
pnpm --filter @celeste/ui build    # -> packages/ui/dist
pnpm --filter @celeste/ui preview  # serve the production build
```

The UI talks to the Celeste daemon on `http://127.0.0.1:9126` by default.
Point it somewhere else with `VITE_CELESTE_API`:

```bash
VITE_CELESTE_API=http://127.0.0.1:9200 pnpm --filter @celeste/ui dev
```

If the daemon is unreachable the client **automatically switches to a built-in
mock daemon** so the UI never renders a broken screen. You can also force it
from the status bar (`Demo mode`) or the command palette.

## Architecture

```
src/
  main.tsx                 React root
  App.tsx                  Layout shell, shortcuts, overlays, panel mode
  api/
    client.ts              Typed HTTP/SSE/WS client + DaemonTransport contract
    connect.ts             Live-vs-mock bootstrap (auto fallback lives here)
    mock.ts                In-browser mock daemon that replays realistic events
    events.ts              Subscription hooks + event de-duplication
  state/
    useCeleste.ts          Reducer, context and the store types
    CelesteProvider.tsx    Wires the store to a transport
    timeline.ts            Pure event -> view-model projections
  components/              Sidebar, Composer, Timeline, ToolCard, JsonView,
                           PlanView, ApprovalCard, ArtifactCard,
                           ProviderPicker, StatusBar, CommandPalette,
                           SettingsPanel, ThreadMenu, EmptyState, Wordmark,
                           SourcesRow, Suggestions, Icon
  lib/                     Markdown renderer, citations, fuzzy matcher,
                           formatting helpers, panel detection, typewriter
  styles/                  theme.css (tokens) + app.css (layout) +
                           markdown.css / sources.css / panel.css
```

### No dependencies beyond React

Everything is hand rolled on purpose: the JSON syntax highlighter, the fuzzy
matcher, the Markdown renderer, the SVG icon set, the wordmark, the state
management and the menus. React and ReactDOM are the only runtime dependencies.

## Panel mode

The same client runs as a full page and as a browser side panel (~400px,
docked to the right of the page, like Perplexity Comet).

Panel mode is detected in `src/lib/panel.ts` from either

- `data-celeste-panel="true"` on `<html>` — the extension's `sidepanel.html`
  sets it, or
- a viewport narrower than 640px.

The resolved state is mirrored back onto `<html>` so `styles/panel.css` can
tighten the layout, and the React tree drops the session sidebar and the
status bar, replacing the sidebar with a compact thread switcher in the
header.

## Keyboard

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + K` | Command palette (sessions, providers, actions) |
| `Cmd/Ctrl + Enter` | New task (focus the composer in new-task mode) |
| `Esc` | Close the palette / settings / menus |
| `Enter` / `Shift + Enter` | Send / newline in the composer |
| `↑ ↓` | Move through menus and the palette |

## Protocol

All routes come from `API_ROUTES` in `@celeste/protocol`, so the client and the
daemon cannot drift apart.
