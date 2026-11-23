# AGENTS.md

OpenCode 2 plugin for the TUI and the desktop app: a sidebar with two sections, Providers (tokens, time, speed and share per provider)
and Agents (every model call in the session tree as agent runs, newest first). Display only; it writes nothing.

- `src/runs.ts`: pure logic. Messages → rounds (one brief, wake-up or compaction) → agent runs; provider
  totals; model names; formatting. No runtime imports; covered by `test/runs.test.ts`.
- `src/tracker.ts`: session data shared by both views. The tracker lives in `createRoot` outside the
  view tree; it loads each session's full history through `client.message.list` (send `order` only on the
  first page: the server rejects it with a cursor), merges it with the live cache once per redraw, and
  coalesces events into at most one redraw per 250 ms. Only a running run's stats line reads the 1 s
  clock. Its only runtime import is `solid-js`, which both hosts provide.
- `src/index.tsx`: Solid/OpenTUI view on the TUI's `sidebar.content` slot (`script/build.mjs` → `dist/index.js`).
- `src/gui.tsx`: Solid DOM view for the desktop app (`script/build-gui.mjs` → `dist/gui-experimental.cjs`,
  CommonJS): an "Agents" side panel tab and a `session.header` summary, one tracker per server.

Before every commit: `npm test`, `npm run typecheck`, `npm run build`. Defects get a failing test first.

Gotchas (from upstream):
- Keep `/** @jsxImportSource @opentui/solid */` on line 1 of `src/index.tsx`, and `/** @jsxImportSource solid-js */`
  on line 1 of `src/gui.tsx`.
- The GUI bundle must keep the app-provided modules external (`PROVIDED` in `script/build-gui.mjs`); a bundled
  copy of `solid-js` would not share the app's reactive runtime.
- Keep the build unminified and `@opencode/plugin/tui`, `@opentui/*`, `solid-js` external (`script/build.mjs`);
  the host rewrites those imports at load time.
