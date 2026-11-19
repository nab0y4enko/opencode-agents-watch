/** @jsxImportSource @opentui/solid */
import type { SessionInfo, SessionMessageAssistant, SessionMessageAssistantTool } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import type { Context as TuiContext } from "@opencode/plugin/tui/context"
import { createMemo, createRoot, createSignal, For, Index, onCleanup, Show, type JSX } from "solid-js"
import {
  agentRuns,
  clamp,
  displayName,
  formatClock,
  formatStats,
  formatTokens,
  mergeMessages,
  providerUsage,
  subagentCalls,
  truncate,
  variantSummary,
  wrap,
  type AgentRun,
  type Message,
  type Model,
  type ModelFacts,
} from "./runs"

// History is read in pages of this size, up to this many pages per session.
const HISTORY_PAGE_SIZE = 200
const HISTORY_PAGES = 25
// Events arrive per streamed chunk; redraw at most this often.
const REDRAW_MS = 250
// Runs shown before older ones fold away.
const VISIBLE_RUNS = 8
// Lines a task or the current tool may take before it is cut.
const TASK_LINES = 2
// Widest line the sidebar shows without cutting it.
const LINE_WIDTH = 36

type Color = TuiContext["theme"]["text"]["base"]
type SectionID = "providers" | "agents"

type Live = {
  busy: (sessionID: string) => boolean
  dispose: () => void
}

type Tracker = {
  children: (parentID: string) => SessionInfo[]
  messages: (sessionID: string) => Message[]
  facts: (model: Model) => ModelFacts | undefined
  provider: (providerID: string) => string
  now: () => number
  collapsed: (section: SectionID) => boolean
  toggleCollapsed: (section: SectionID) => void
  showAll: (sessionID: string) => boolean
  toggleShowAll: (sessionID: string) => void
  dispose: () => void
}

// Which sessions are running, from session events plus the status cache.
function createLive(ctx: TuiContext): Live {
  const running = new Set<string>()
  let disposed = false

  void ctx.client.session
    .active()
    .then((active) => {
      if (disposed) return
      for (const sessionID of Object.keys(active)) running.add(sessionID)
    })
    .catch(() => {})

  const stop = (event: { data: { sessionID: string } }) => running.delete(event.data.sessionID)
  const unsubs = [
    ctx.data.on("session.status", (event) => {
      if (event.data.status.type === "idle") running.delete(event.data.sessionID)
      else running.add(event.data.sessionID)
    }),
    ctx.data.on("session.execution.started", (event) => running.add(event.data.sessionID)),
    ctx.data.on("session.step.started", (event) => running.add(event.data.sessionID)),
    ctx.data.on("session.execution.succeeded", stop),
    ctx.data.on("session.execution.failed", stop),
    ctx.data.on("session.execution.interrupted", stop),
  ]

  return {
    busy: (sessionID) => ctx.data.session.status(sessionID) === "running" || running.has(sessionID),
    dispose() {
      disposed = true
      for (const unsubscribe of unsubs) unsubscribe()
    },
  }
}

// Session data shared by every sidebar instance; lives outside the slot tree so
// re-renders keep it.
function createTracker(ctx: TuiContext): Tracker {
  return createRoot((dispose) => {
    const [revision, setRevision] = createSignal(0)
    // Coalesce bursts of events into one redraw.
    let redraw: ReturnType<typeof setTimeout> | undefined
    const touch = () => {
      if (redraw) return
      redraw = setTimeout(() => {
        redraw = undefined
        setRevision((value) => value + 1)
      }, REDRAW_MS)
    }
    const [now, setNow] = createSignal(Date.now())
    const [sections, updateSections] = ctx.storage.store("sections", { initial: { providers: false, agents: false } })
    const [ui, updateUi] = ctx.storage.memory("ui", { initial: { showAll: {} as Record<string, boolean> } })
    const [bootstrap, setBootstrap] = createSignal<SessionInfo[]>([])
    let disposed = false

    void ctx.client.session
      .list({})
      .then((response) => {
        if (!disposed) setBootstrap(response.data)
      })
      .catch(() => {})

    // Model names, real model IDs, variant settings and provider names.
    void Promise.all([ctx.data.location.model.sync(), ctx.data.location.provider.sync()])
      .then(touch)
      .catch(() => {})

    const sessions = createMemo(() => {
      revision()
      const merged = new Map<string, SessionInfo>()
      for (const session of bootstrap()) merged.set(session.id, session)
      for (const session of ctx.data.session.list()) merged.set(session.id, session)
      return [...merged.values()]
    })

    // The live cache keeps only recent messages, so read each session's full
    // history page by page, and again whenever the session goes idle.
    const history = new Map<string, Message[]>()
    const loading = new Set<string>()
    const stale = new Set<string>()
    async function load(sessionID: string) {
      if (loading.has(sessionID)) {
        stale.add(sessionID)
        return
      }
      loading.add(sessionID)
      const all: Message[] = []
      try {
        const seen = new Set<string>()
        let cursor: string | undefined
        for (let page = 0; page < HISTORY_PAGES; page += 1) {
          // The server rejects `order` together with `cursor`; the cursor carries the order.
          const response = await ctx.client.message.list(
            cursor ? { sessionID, limit: HISTORY_PAGE_SIZE, cursor } : { sessionID, limit: HISTORY_PAGE_SIZE, order: "asc" },
          )
          const fresh = response.data.filter((message) => !seen.has(message.id))
          for (const message of fresh) seen.add(message.id)
          all.push(...(fresh as Message[]))
          cursor = response.cursor.next ?? undefined
          // The last page still returns a cursor; stop when a page brings nothing new.
          if (!cursor || fresh.length === 0) break
        }
      } catch {
        // Keep the pages read so far; the live cache fills in the rest.
      }
      if (!disposed && all.length > 0) {
        history.set(sessionID, all)
        touch()
      }
      loading.delete(sessionID)
      if (stale.delete(sessionID)) void load(sessionID)
    }
    const reload = (event: { data: { sessionID: string } }) => {
      if (history.has(event.data.sessionID)) void load(event.data.sessionID)
    }
    const requested = new Set<string>()
    function ensure(sessionID: string) {
      if (requested.has(sessionID)) return
      requested.add(sessionID)
      void ctx.data.session.message.sync(sessionID).then(touch).catch(() => {})
      void load(sessionID)
    }

    // One merge per session per redraw, however many views read it.
    const merged = new Map<string, { revision: number; messages: Message[] }>()

    const unsubs = [
      ctx.data.on("session.execution.succeeded", reload),
      ctx.data.on("session.execution.failed", reload),
      ctx.data.on("session.execution.interrupted", reload),
      ctx.data.listen(({ details }) => {
        touch()
        if (details.type === "session.deleted") {
          const sessionID = details.data.sessionID
          setBootstrap((current) => current.filter((session) => session.id !== sessionID))
          history.delete(sessionID)
          merged.delete(sessionID)
          requested.delete(sessionID)
        }
      }),
    ]
    const clock = setInterval(() => setNow(Date.now()), 1000)

    onCleanup(() => {
      disposed = true
      clearInterval(clock)
      if (redraw) clearTimeout(redraw)
      for (const unsubscribe of unsubs) unsubscribe()
    })

    return {
      children: (parentID) => sessions().filter((session) => session.parentID === parentID),
      messages(sessionID) {
        const current = revision()
        ensure(sessionID)
        const cached = merged.get(sessionID)
        if (cached?.revision === current) return cached.messages
        const live = ctx.data.session.message.list(sessionID) as Message[]
        const messages = mergeMessages(history.get(sessionID) ?? [], live)
        merged.set(sessionID, { revision: current, messages })
        return messages
      },
      facts(model) {
        revision()
        const info = ctx.data.location.model.list()?.find(
          (item) => item.providerID === model.providerID && item.id === model.id,
        )
        if (!info) return undefined
        return {
          name: info.name,
          provider: ctx.data.location.provider.list()?.find((item) => item.id === info.providerID)?.name,
          modelID: info.modelID,
          variants: info.variants,
        }
      },
      // The provider's configured name, such as "OpenAI" or "Splash".
      provider(providerID) {
        revision()
        return ctx.data.location.provider.list()?.find((item) => item.id === providerID)?.name ?? providerID
      },
      now,
      collapsed: (section) => sections[section],
      toggleCollapsed(section) {
        const next = !sections[section]
        void updateSections((draft) => {
          draft[section] = next
        })
      },
      showAll: (sessionID) => ui.showAll[sessionID] ?? false,
      toggleShowAll(sessionID) {
        updateUi((draft) => {
          draft.showAll[sessionID] = !(draft.showAll[sessionID] ?? false)
        })
      },
      dispose,
    }
  })
}

function toolSummary(part: SessionMessageAssistantTool) {
  const input = part.state.input
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const detail = record.description ?? record.command ?? record.filePath ?? record.path ?? record.pattern ?? ""
  const text = detail ? `${part.name} ${String(detail).split("\n")[0]}` : part.name
  return truncate(text, 60)
}

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
    const messages = props.tracker.messages(run().sessionID)
    const last = messages.findLast((item) => item.type === "assistant") as SessionMessageAssistant | undefined
    const part = last?.content.findLast((item): item is SessionMessageAssistantTool => item.type === "tool")
    return clamp(wrap(`now: ${part ? toolSummary(part) : "thinking"}`, LINE_WIDTH, "  ", "    "), TASK_LINES, LINE_WIDTH)
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
  const children = createMemo(() => props.tracker.children(props.sessionID))
  const parent = createMemo(() => props.tracker.messages(props.sessionID))
  const calls = createMemo(() => subagentCalls(parent()))

  // Every model call in the session tree, as runs in the order they started.
  const runs = createMemo(() =>
    agentRuns([
      // The orchestrator's turns count too; each round is attributed to the agent
      // of its steps, so agent switches and compactions show as theirs.
      { sessionID: props.sessionID, agent: "orchestrator", messages: parent(), newRunPerPrompt: true },
      ...children().map((child) => ({
        sessionID: child.id,
        agent: child.agent ?? "agent",
        messages: props.tracker.messages(child.id),
        calls: calls().filter((call) => call.sessionID === child.id),
      })),
    ]),
  )
  // Newest first: the running run sits on top.
  const shown = createMemo(() => {
    const newest = [...runs()].reverse()
    return props.tracker.showAll(props.sessionID) ? newest : newest.slice(0, VISIBLE_RUNS)
  })
  const hidden = () => runs().length - shown().length

  const providers = createMemo(() =>
    providerUsage([parent(), ...children().map((child) => props.tracker.messages(child.id))]),
  )
  const total = () => providers().reduce((sum, usage) => sum + usage.generated, 0)
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
    const live = createLive(ctx)
    const tracker = createTracker(ctx)

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
