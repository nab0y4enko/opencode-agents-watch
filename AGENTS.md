# AGENTS.md

OpenCode 2 TUI plugin: a sidebar with two sections, Providers (tokens, time, speed and share per provider)
and Agents (every model call in the session tree as agent runs, newest first). Display only; it writes nothing.

- `src/runs.ts`: pure logic. Messages → rounds (one brief, wake-up or compaction) → agent runs; provider
  totals; model names; formatting. No runtime imports; covered by `test/runs.test.ts`.
- `src/index.tsx`: Solid/OpenTUI view on the `sidebar.content` slot. The tracker lives in `createRoot`
  outside the slot tree; it loads each session's full history through `ctx.client.message.list` (send
  `order` only on the first page: the server rejects it with a cursor), merges it with the live cache once
  per redraw, and coalesces events into at most one redraw per 250 ms. Only a running run's stats line
  reads the 1 s clock.

Before every commit: `npm test`, `npm run typecheck`, `npm run build`. Defects get a failing test first.

Gotchas (from upstream):
- Keep `/** @jsxImportSource @opentui/solid */` on line 1 of `src/index.tsx`.
- Keep the build unminified and `@opencode/plugin/tui`, `@opentui/*`, `solid-js` external (`script/build.mjs`);
  the host rewrites those imports at load time.
