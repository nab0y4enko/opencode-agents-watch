/** @jsxImportSource solid-js */
// The desktop app's view: an "Agents" tab in the session's side region with
// the same Providers and Agents sections as the terminal sidebar, and a short
// summary in the session header that opens it. Built by script/build-gui.mjs
// into dist/gui-experimental.cjs.
import { Command, MenuItem, Panel, Plugin, Slot, Style, type MountedSession, type PanelTab, type ServerRef } from "@opencode/plugin/gui"
import { createMemo, For, Index, Show, type JSX } from "solid-js"
import { displayName, formatClock, formatStats, formatTokens, variantSummary, type AgentRun } from "./runs"
import { createLive, createSummary, createTracker, currentTool, type Live, type SectionID, type Tracker } from "./tracker"

// Runs shown before older ones fold away.
const VISIBLE_RUNS = 8
const TAB_ID = "main"
const TAB: PanelTab = { id: TAB_ID, title: "Agents", closable: "hover" }

type Watch = { tracker: Tracker; live: Live; server: ServerRef; data: ServerRef["data"] }

const CSS = `
.aw-root { padding: 12px 14px 24px; font-size: 13px; line-height: 1.45; color: var(--v2-text-text-base); overflow-y: auto; height: 100%; box-sizing: border-box; }
.aw-empty { color: var(--v2-text-text-muted); padding: 8px 0; }
.aw-section { margin-bottom: 16px; }
.aw-section-head { display: flex; gap: 6px; align-items: baseline; cursor: pointer; user-select: none; margin-bottom: 8px; background: none; border: 0; padding: 0; color: inherit; font: inherit; }
.aw-section-head b { font-weight: 600; }
.aw-chevron { width: 10px; color: var(--v2-text-text-muted); font-size: 10px; }
.aw-muted { color: var(--v2-text-text-muted); }
.aw-faint { color: var(--v2-text-text-faint); }
.aw-provider { margin-bottom: 6px; }
.aw-bar { height: 3px; border-radius: 2px; background: var(--v2-border-border-muted); margin-top: 3px; overflow: hidden; }
.aw-bar > span { display: block; height: 100%; background: var(--v2-text-text-accent); }
.aw-run { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: none; border: 0; border-radius: 6px; padding: 6px 8px; margin: 0 -8px 4px; cursor: pointer; }
.aw-run:hover { background: var(--v2-overlay-simple-overlay-hover); }
.aw-run-head { display: flex; gap: 6px; align-items: baseline; }
.aw-run-head .aw-agent { font-weight: 600; }
.aw-badge { font-size: 11px; padding: 0 6px; border-radius: 8px; border: 1px solid currentColor; }
.aw-running { color: var(--v2-state-fg-info); }
.aw-failed { color: var(--v2-state-fg-danger); }
.aw-now { color: var(--v2-state-fg-warning); }
.aw-indent { padding-left: 12px; }
.aw-clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.aw-tasks { margin: 2px 0 0; padding-left: 12px; list-style: none; }
.aw-tasks.aw-numbered { list-style: decimal; padding-left: 28px; }
.aw-more { background: none; border: 0; padding: 0; font: inherit; color: var(--v2-text-text-accent); cursor: pointer; }
.aw-header { background: none; border: 0; padding: 2px 6px; border-radius: 6px; font: inherit; font-size: 12px; color: var(--v2-text-text-muted); cursor: pointer; white-space: nowrap; }
.aw-header:hover { background: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-base); }
`

export default Plugin.define({
  setup(ctx) {
    const key = `${ctx.id}:${TAB_ID}`
    const sections = ctx.storage.memory("sections", { initial: { providers: false, agents: false } })
    const ui = ctx.storage.memory("ui", { initial: { showAll: {} as Record<string, boolean> } })

    // One tracker per server, rebuilt when the server reconnects with new data.
    const watches = new Map<string, Watch>()
    function watch(server: ServerRef): Watch {
      const current = watches.get(server.id)
      if (current && current.data === server.data) return current
      if (current) {
        current.tracker.dispose()
        current.live.dispose()
      }
      const source = { client: () => server.client, data: () => server.data }
      const next = { tracker: createTracker({ ...source, sections, ui }), live: createLive(source), server, data: server.data }
      watches.set(server.id, next)
      return next
    }

    const toggle = () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.toggle(key, session)
    }

    function Section(props: { tracker: Tracker; id: SectionID; title: string; summary: string; children: JSX.Element }) {
      return (
        <div class="aw-section">
          <button type="button" class="aw-section-head" onClick={() => props.tracker.toggleCollapsed(props.id)}>
            <span class="aw-chevron">{props.tracker.collapsed(props.id) ? "▶" : "▼"}</span>
            <b>{props.title}</b>
            <span class="aw-muted">{props.summary}</span>
          </button>
          <Show when={!props.tracker.collapsed(props.id)}>{props.children}</Show>
        </div>
      )
    }

    function Run(props: { watch: Watch; session: MountedSession; run: AgentRun }) {
      const run = () => props.run
      const tracker = () => props.watch.tracker
      const running = createMemo(() => run().runningSince !== undefined && props.watch.live.busy(run().sessionID))
      const model = createMemo(() => {
        const current = run().model
        if (!current) return { name: "unknown model", variant: undefined }
        const facts = tracker().facts(current, props.session.location)
        const summary = variantSummary(facts, current.variant)
        return {
          name: `${facts?.provider ?? current.providerID} · ${displayName(facts, current)}`,
          variant: current.variant ? (summary ? `${current.variant} · ${summary}` : current.variant) : undefined,
        }
      })
      // The only line that changes every second while the run is running.
      const stats = () => {
        const since = run().runningSince
        const busy = run().busy + (since !== undefined && running() ? tracker().now() - since : 0)
        return formatStats(busy, run().generated, run().streaming)
      }
      const now = createMemo(() => (running() ? currentTool(tracker().messages(run().sessionID)) : undefined))
      return (
        <button
          type="button"
          class="aw-run"
          title="Open this session"
          onClick={() => ctx.tabs.open({ server: props.session.server.id, id: run().sessionID }, { focus: true })}
        >
          <div class="aw-run-head" classList={{ "aw-running": running(), "aw-failed": !running() && run().failed }}>
            <span class="aw-faint">{formatClock(run().start)}</span>
            <span class="aw-agent">{run().agent}</span>
            <Show when={running()}>
              <span class="aw-badge">running</span>
            </Show>
            <Show when={!running() && run().failed}>
              <span class="aw-badge">failed</span>
            </Show>
          </div>
          <div class="aw-indent aw-muted">{model().name}</div>
          <Show when={model().variant}>
            <div class="aw-indent aw-muted">{model().variant}</div>
          </Show>
          <div class="aw-indent aw-muted">{stats()}</div>
          <Show when={run().tasks.length > 0}>
            <ol class="aw-tasks" classList={{ "aw-numbered": run().tasks.length > 1 }}>
              <For each={run().tasks}>{(task) => <li class="aw-clamp">{task}</li>}</For>
            </ol>
          </Show>
          <Show when={run().jobs > 0}>
            <div class="aw-indent aw-muted">
              {run().jobs} background job{run().jobs === 1 ? "" : "s"}
            </div>
          </Show>
          <Show when={now()}>
            <div class="aw-indent aw-now aw-clamp">now: {now()}</div>
          </Show>
        </button>
      )
    }

    function Body(props: { watch: Watch; session: MountedSession }) {
      const tracker = () => props.watch.tracker
      const { runs, providers, total } = createSummary(props.watch.tracker, () => props.session.id)
      // Newest first: the running run sits on top.
      const shown = createMemo(() => {
        const newest = [...runs()].reverse()
        return tracker().showAll(props.session.id) ? newest : newest.slice(0, VISIBLE_RUNS)
      })
      const hidden = () => runs().length - shown().length
      return (
        <Show when={runs().length > 0} fallback={<div class="aw-empty">No model calls in this session yet.</div>}>
          <Section tracker={tracker()} id="providers" title="Providers" summary={`· ${formatTokens(total())} tokens`}>
            <For each={providers()}>
              {(usage) => (
                <div class="aw-provider">
                  <div>{tracker().provider(usage.providerID, props.session.location)}</div>
                  <div class="aw-indent aw-muted">
                    {formatStats(usage.time, usage.generated, usage.streaming)} · {Math.round(usage.share * 100)}%
                  </div>
                  <div class="aw-bar aw-indent">
                    <span style={{ width: `${Math.round(usage.share * 100)}%` }} />
                  </div>
                </div>
              )}
            </For>
          </Section>
          <Section
            tracker={tracker()}
            id="agents"
            title="Agents"
            summary={`· ${runs().length} run${runs().length === 1 ? "" : "s"}`}
          >
            {/* Index, not For: runs are rebuilt on every redraw, so match them by position. */}
            <Index each={shown()}>{(run) => <Run watch={props.watch} session={props.session} run={run()} />}</Index>
            <Show when={hidden() > 0 || runs().length > VISIBLE_RUNS}>
              <button type="button" class="aw-more" onClick={() => tracker().toggleShowAll(props.session.id)}>
                {hidden() > 0 ? `${hidden()} older, show all` : "show recent only"}
              </button>
            </Show>
          </Section>
        </Show>
      )
    }

    // Reads `session` where it is used, so a routed session switch arrives without a remount.
    function View(props: { session: MountedSession }) {
      const current = createMemo(() => watch(props.session.server))
      return (
        <div class="aw-root">
          <Show when={current()} keyed>
            {(w) => <Body watch={w} session={props.session} />}
          </Show>
        </div>
      )
    }

    // "182k tok · 2 running" in the session header; opens the panel.
    function Header(props: { session: MountedSession; compact: boolean }) {
      const current = createMemo(() => watch(props.session.server))
      return (
        <Show when={current()} keyed>
          {(w) => {
            const { runs, total } = createSummary(w.tracker, () => props.session.id)
            const running = () => runs().filter((run) => run.runningSince !== undefined && w.live.busy(run.sessionID)).length
            return (
              <Show when={!props.compact && runs().length > 0}>
                <button
                  type="button"
                  class="aw-header"
                  title="Agents: providers and agent runs"
                  onClick={() => ctx.layout.toggle(key, props.session)}
                >
                  {formatTokens(total())} tok
                  {running() > 0 ? ` · ${running()} running` : ` · ${runs().length} run${runs().length === 1 ? "" : "s"}`}
                </button>
              </Show>
            )
          }}
        </Show>
      )
    }

    ctx.add(Style, CSS)
    ctx.add(Panel, {
      id: TAB_ID,
      region: "side",
      width: 360,
      mobile: { title: "Agents", order: 50, kind: "menu", icon: "status" },
      list: (input) => (input.open.includes(TAB_ID) ? [TAB] : []),
      render: (props) => <View session={props.session} />,
    })
    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current()
      return {
        menu: "session.panel",
        id: "open",
        title: "Agents",
        icon: "status",
        keybind: `${ctx.id}.toggle`,
        opened: session ? ctx.layout.state(key, session) !== "closed" : false,
        run: () => {
          const target = ctx.sessions.current()
          if (target) ctx.layout.open(key, target)
        },
      }
    })
    ctx.add(Command, {
      id: "toggle",
      title: "Toggle Agents panel",
      description: "Tokens, time and speed per provider, and every agent run",
      keywords: "agents providers tokens runs watch",
      section: "session",
      run: toggle,
    })
    ctx.add(Slot, {
      at: "session.header",
      render: (input) => <Header session={input.session} compact={input.compact} />,
    })

    return () => {
      for (const current of watches.values()) {
        current.tracker.dispose()
        current.live.dispose()
      }
      watches.clear()
    }
  },
})
