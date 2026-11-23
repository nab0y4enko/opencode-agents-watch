# opencode-agents-watch

An OpenCode 2 sidebar for orchestrator/worker runs, in the terminal UI and the desktop app. Forked from
[opencode-agents-watcher](https://github.com/RainingDaemons/opencode-agents-watcher) (MIT); the restart
supervisor and its `.opencode/` state files are gone, so this version only displays.

```
▼ Providers · 199k tokens
Splash
  35m 38s · 182k · 96 tok/s · 92%
OpenAI
  8m 50s · 16k · 41 tok/s · 8%

▼ Agents · 25 runs
13:03 build
  OpenAI · GPT-6.2 Sol
  high
  49.6s · 1k · 35 tok/s
  Tvos app's dashboard still use
  blue color for buttons. why?

12:39 validator
  Splash · Qwen3.8 Flash Next IQ3_S
  lite-512 · low effort, think ≤512
  42.5s · 4k · 95 tok/s
  Confirm final test plan
```

**Providers** — all generated tokens (output + reasoning), then for each provider, under its configured
name: time · tokens · tok/s · share of all tokens. A provider's time is its models' step time (request to
last token), so tool runs between steps are not in it.

**Agents** — every model call in the session tree as runs, newest on top: the orchestrator's turns, every
worker, and context compactions, each attributed to the agent and model of its actual steps, so any
provider, model or agent switch shows up. An agent's back-to-back rounds share a run; a new prompt to the
orchestrator always starts one. Each run shows:

- start time and agent, plus `running` or `failed`;
- the provider's configured name and the model (a configured name with no digit, like "Splash Worker", is
  replaced by a short form of the model ID);
- the variant and what it does, from its request body (`reasoning_effort`, `thinking_token_budget` or
  `thinking_budget`);
- wall time of its rounds · generated tokens · tok/s (streaming only, prompt processing excluded);
- its tasks: the orchestrator's `subagent` descriptions (matched to briefs by prompt text), your prompt,
  or `after implementer` when a worker's result woke the orchestrator; at most two lines each;
- background-job wake-ups, and the current tool while it runs.

The 8 newest runs are shown; click the "older" line for all. Click a run to open its session, a section
title to collapse it. Each session's full history is read through the API (the live cache keeps only
recent messages) and re-read when the session goes idle. Calls that leave nothing in a session, such as
session titles, can't be shown.

## Install

```sh
npm install && npm run build
```

A `plugins` entry in `opencode.jsonc` must be an npm or Git package; a folder path there is silently
ignored. Load the working copy through the global plugins folder instead (it also survives a profile
reinstall, which rewrites only `opencode.jsonc` and `AGENTS.md`):

```sh
mkdir -p ~/.config/opencode/plugins/agents-watch
echo "export { default } from \"$PWD/dist/index.js\"" > ~/.config/opencode/plugins/agents-watch/tui.tsx
```

Restart OpenCode; the widget sits in the session sidebar (`ctrl+x` `b` toggles the sidebar).

### Desktop app

The desktop app can't show TUI plugins; it loads the plugin's `./gui-experimental` bundle instead (the
GUI plugin API is experimental upstream). Copy the bundle next to `tui.tsx`, and copy it again after each
build. A symlink won't work: the server ignores a bundle whose real path is outside the plugin folder.

```sh
cp dist/gui-experimental.cjs ~/.config/opencode/plugins/agents-watch/
```

The server reads the plugins folder when it starts, so restart it (`opencode service restart`) and then the
app; `opencode api GET /api/plugin` should list `agents-watch` with `gui: true`. In a session, open **Agents** from the side
panel's + menu or with the "Toggle Agents panel" command; the session header shows the session's tokens
and running agents, and a click on it toggles the panel. Click a run to open its session.

## Develop

Bun comes inside the OpenCode binary (`BUN_BE_BUN=1 opencode …`), so no separate install is needed.

```sh
npm test            # runs, provider totals, names and formatting (src/runs.ts)
npm run typecheck
npm run build       # writes dist/index.js and dist/gui-experimental.cjs; rebuild and restart OpenCode after changes
```
