/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context as TuiContext } from "@opencode/plugin/tui/context"
import { createMemo, For, Index, Show, type JSX } from "solid-js"
import {
  clamp,
  displayName,
  formatClock,
  formatStats,
  formatTokens,
  variantSummary,
  wrap,
  type AgentRun,
} from "./runs"
import { createLive, createSummary, createTracker, currentTool, type Live, type SectionID, type Tracker } from "./tracker"

// Runs shown before older ones fold away.
const VISIBLE_RUNS = 8
// Lines a task or the current tool may take before it is cut.
const TASK_LINES = 2
// Widest line the sidebar shows without cutting it.
const LINE_WIDTH = 36

type Color = TuiContext["theme"]["text"]["base"]

function Lines(props: { lines: string[]; color: Color }) {
  return <For each={props.lines}>{(line) => <text fg={props.color}>{line}</text>}</For>
}

// A collapsible section: "▼ Providers · 199k tokens".
function Section(props: { ctx: TuiContext; tracker: Tracker; id: SectionID; title: string; summary: string; children: JSX.Element }) {
  const theme = () => props.ctx.theme
  return (
    <box marginBottom={1}>
      <box flexDirection="row" gap={1} onMouseDown={() => props.tracker.toggleCollapsed(props.id)}>
        <text fg={theme().text.base}>{props.tracker.collapsed(props.id) ? "▶" : "▼"}</text>
        <text fg={theme().text.base}>
          <b>{props.title}</b>
        </text>
        <text fg={theme().text.muted}>{props.summary}</text>
      </box>
      <Show when={!props.tracker.collapsed(props.id)}>{props.children}</Show>
    </box>
  )
}

// One agent run: header, model, variant, stats, tasks, background jobs, and
// the current tool while it runs.
function Run(props: { ctx: TuiContext; tracker: Tracker; live: Live; run: AgentRun }) {
  const theme = () => props.ctx.theme
  const run = () => props.run
  const running = createMemo(() => run().runningSince !== undefined && props.live.busy(run().sessionID))
  const color = () =>
    running() ? theme().text.feedback.info.base : run().failed ? theme().text.feedback.error.base : theme().text.base
  // "12:37 implementer", plus "running" or "failed".
  const head = createMemo(() => {
    const status = running() ? " running" : run().failed ? " failed" : ""
    return wrap(`${formatClock(run().start)} ${run().agent}${status}`, LINE_WIDTH)
  })
  // Provider and model, then the variant and what it does.
  const model = createMemo(() => {
    const current = run().model
    if (!current) return wrap("unknown model", LINE_WIDTH, "  ")
    const facts = props.tracker.facts(current)
    const summary = variantSummary(facts, current.variant)
    return [
      ...wrap(`${facts?.provider ?? current.providerID} · ${displayName(facts, current)}`, LINE_WIDTH, "  ", "    "),
      ...(current.variant ? wrap(summary ? `${current.variant} · ${summary}` : current.variant, LINE_WIDTH, "  ") : []),
    ]
  })
  // The only line that changes every second while the run is running.
  const stats = () => {
    const since = run().runningSince
    const busy = run().busy + (since !== undefined && running() ? props.tracker.now() - since : 0)
    return wrap(formatStats(busy, run().generated, run().streaming), LINE_WIDTH, "  ")
  }
  const tasks = createMemo(() => {
    const list = run().tasks
    if (list.length === 1) return clamp(wrap(list[0]!, LINE_WIDTH, "  "), TASK_LINES, LINE_WIDTH)
    return list.flatMap((task, index) => {
      const number = `  ${index + 1}. `
      return clamp(wrap(task, LINE_WIDTH, number, " ".repeat(number.length)), TASK_LINES, LINE_WIDTH)
    })
  })
  const jobs = () => (run().jobs > 0 ? [`  ${run().jobs} background job${run().jobs === 1 ? "" : "s"}`] : [])
  const now = createMemo(() => {
    if (!running()) return []
    const tool = currentTool(props.tracker.messages(run().sessionID))
    return clamp(wrap(`now: ${tool}`, LINE_WIDTH, "  ", "    "), TASK_LINES, LINE_WIDTH)
  })
  return (
    <box marginBottom={1} onMouseDown={() => props.ctx.ui.router.navigate({ type: "session", sessionID: run().sessionID })}>
      <Lines lines={head()} color={color()} />
      <Lines lines={model()} color={theme().text.muted} />
      <Lines lines={stats()} color={theme().text.muted} />
      <Lines lines={tasks()} color={theme().text.base} />
      <Lines lines={jobs()} color={theme().text.muted} />
      <Lines lines={now()} color={theme().text.feedback.warning.base} />
    </box>
  )
}

function Sidebar(props: { ctx: TuiContext; tracker: Tracker; live: Live; sessionID: string }) {
  const theme = () => props.ctx.theme
  const { runs, providers, total } = createSummary(props.tracker, () => props.sessionID)
  // Newest first: the running run sits on top.
  const shown = createMemo(() => {
    const newest = [...runs()].reverse()
    return props.tracker.showAll(props.sessionID) ? newest : newest.slice(0, VISIBLE_RUNS)
  })
  const hidden = () => runs().length - shown().length

  // The provider, then time · tokens · speed like a run, ending with its share.
  const providerLines = createMemo(() =>
    providers().flatMap((usage) => [
      ...wrap(props.tracker.provider(usage.providerID), LINE_WIDTH),
      ...wrap(`${formatStats(usage.time, usage.generated, usage.streaming)} · ${Math.round(usage.share * 100)}%`, LINE_WIDTH, "  "),
    ]),
  )

  return (
    <Show when={runs().length > 0}>
      <Section ctx={props.ctx} tracker={props.tracker} id="providers" title="Providers" summary={`· ${formatTokens(total())} tokens`}>
        <Lines lines={providerLines()} color={theme().text.muted} />
      </Section>
      <Section
        ctx={props.ctx}
        tracker={props.tracker}
        id="agents"
        title="Agents"
        summary={`· ${runs().length} run${runs().length === 1 ? "" : "s"}`}
      >
        {/* Index, not For: runs are rebuilt on every redraw, so match them by position. */}
        <Index each={shown()}>{(run) => <Run ctx={props.ctx} tracker={props.tracker} live={props.live} run={run()} />}</Index>
        <Show when={hidden() > 0 || runs().length > VISIBLE_RUNS}>
          <box onMouseDown={() => props.tracker.toggleShowAll(props.sessionID)}>
            <text fg={theme().text.action.primary.base}>
              {hidden() > 0 ? `${hidden()} older, click to show all` : "click to show recent only"}
            </text>
          </box>
        </Show>
      </Section>
    </Show>
  )
}

export default Plugin.define({
  id: "agents-watch",
  setup(ctx) {
    const source = { client: () => ctx.client, data: () => ctx.data }
    const live = createLive(source)
    const tracker = createTracker({
      ...source,
      sections: ctx.storage.store("sections", { initial: { providers: false, agents: false } }),
      ui: ctx.storage.memory("ui", { initial: { showAll: {} as Record<string, boolean> } }),
    })

    const unregisterSlot = ctx.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <Sidebar ctx={ctx} tracker={tracker} live={live} sessionID={sessionID} />,
    })

    return () => {
      unregisterSlot()
      tracker.dispose()
      live.dispose()
    }
  },
})
