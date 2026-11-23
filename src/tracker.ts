// Session data for the views: which sessions run, each session's full message
// history merged with the live cache, and model and provider names. Shared by
// the terminal sidebar (src/index.tsx) and the desktop panel (src/gui.tsx); its
// only runtime import is solid-js, which both hosts provide.
import type {
  LocationRef,
  ModelInfo,
  OpenCodeClient,
  OpenCodeEvent,
  ProviderInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"
import { createMemo, createRoot, createSignal, onCleanup } from "solid-js"
import {
  agentRuns,
  mergeMessages,
  providerUsage,
  subagentCalls,
  truncate,
  type Message,
  type Model,
  type ModelFacts,
} from "./runs"

// History is read in pages of this size, up to this many pages per session.
const HISTORY_PAGE_SIZE = 200
const HISTORY_PAGES = 25
// Events arrive per streamed chunk; redraw at most this often.
const REDRAW_MS = 250

type EventOf<Type extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: Type }>

type Collection<Value> = {
  list(location?: LocationRef): Value[] | undefined
  sync(location?: LocationRef): Promise<void>
}

// The part of a host's synced data the tracker reads; the terminal's
// `ctx.data` and the desktop's `ServerRef.data` both have it.
export type DataSource = {
  on<Type extends OpenCodeEvent["type"]>(type: Type, handler: (event: EventOf<Type>) => void): () => void
  listen(handler: (event: { details: OpenCodeEvent }) => void): () => void
  session: {
    list(): SessionInfo[]
    status(sessionID: string): "idle" | "running"
    message: {
      list(sessionID: string): SessionMessageInfo[]
      sync(sessionID: string): Promise<void>
    }
  }
  location: {
    model: Collection<ModelInfo>
    provider: Collection<ProviderInfo>
  }
}

export type SectionID = "providers" | "agents"
type Sections = Record<SectionID, boolean>
type Ui = { showAll: Record<string, boolean> }
type StoreTuple<T> = readonly [T, (mutation: (draft: T) => void) => unknown]

export type TrackerSource = {
  client: () => OpenCodeClient
  data: () => DataSource
  sections: StoreTuple<Sections>
  ui: StoreTuple<Ui>
}

export type Live = {
  busy: (sessionID: string) => boolean
  dispose: () => void
}

export type Tracker = {
  children: (parentID: string) => SessionInfo[]
  messages: (sessionID: string) => Message[]
  facts: (model: Model, location?: LocationRef) => ModelFacts | undefined
  provider: (providerID: string, location?: LocationRef) => string
  now: () => number
  collapsed: (section: SectionID) => boolean
  toggleCollapsed: (section: SectionID) => void
  showAll: (sessionID: string) => boolean
  toggleShowAll: (sessionID: string) => void
  dispose: () => void
}

// Which sessions are running, from session events plus the status cache.
export function createLive(source: Pick<TrackerSource, "client" | "data">): Live {
  const running = new Set<string>()
  let disposed = false
  const data = source.data()

  void source
    .client()
    .session.active()
    .then((active) => {
      if (disposed) return
      for (const sessionID of Object.keys(active)) running.add(sessionID)
    })
    .catch(() => {})

  const stop = (event: { data: { sessionID: string } }) => running.delete(event.data.sessionID)
  const unsubs = [
    data.on("session.status", (event) => {
      if (event.data.status.type === "idle") running.delete(event.data.sessionID)
      else running.add(event.data.sessionID)
    }),
    data.on("session.execution.started", (event) => running.add(event.data.sessionID)),
    data.on("session.step.started", (event) => running.add(event.data.sessionID)),
    data.on("session.execution.succeeded", stop),
    data.on("session.execution.failed", stop),
    data.on("session.execution.interrupted", stop),
  ]

  return {
    busy: (sessionID) => data.session.status(sessionID) === "running" || running.has(sessionID),
    dispose() {
      disposed = true
      for (const unsubscribe of unsubs) unsubscribe()
    },
  }
}

// Session data shared by every view of one server; lives in its own root so
// re-renders keep it.
export function createTracker(source: TrackerSource): Tracker {
  return createRoot((dispose) => {
    const data = source.data()
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
    const [sections, updateSections] = source.sections
    const [ui, updateUi] = source.ui
    const [bootstrap, setBootstrap] = createSignal<SessionInfo[]>([])
    let disposed = false

    void source
      .client()
      .session.list({})
      .then((response) => {
        if (!disposed) setBootstrap(response.data)
      })
      .catch(() => {})

    // Model names, real model IDs, variant settings and provider names, once per location.
    const synced = new Set<string>()
    function syncLocation(location: LocationRef | undefined) {
      const key = location ? JSON.stringify(location) : ""
      if (synced.has(key)) return
      synced.add(key)
      void Promise.all([data.location.model.sync(location), data.location.provider.sync(location)])
        .then(touch)
        .catch(() => {})
    }

    const sessions = createMemo(() => {
      revision()
      const merged = new Map<string, SessionInfo>()
      for (const session of bootstrap()) merged.set(session.id, session)
      for (const session of data.session.list()) merged.set(session.id, session)
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
          const response = await source
            .client()
            .message.list(
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
      void data.session.message.sync(sessionID).then(touch).catch(() => {})
      void load(sessionID)
    }

    // One merge per session per redraw, however many views read it.
    const merged = new Map<string, { revision: number; messages: Message[] }>()

    const unsubs = [
      data.on("session.execution.succeeded", reload),
      data.on("session.execution.failed", reload),
      data.on("session.execution.interrupted", reload),
      data.listen(({ details }) => {
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
        const live = data.session.message.list(sessionID) as Message[]
        const messages = mergeMessages(history.get(sessionID) ?? [], live)
        merged.set(sessionID, { revision: current, messages })
        return messages
      },
      facts(model, location) {
        revision()
        syncLocation(location)
        const info = data.location.model
          .list(location)
          ?.find((item) => item.providerID === model.providerID && item.id === model.id)
        if (!info) return undefined
        return {
          name: info.name,
          provider: data.location.provider.list(location)?.find((item) => item.id === info.providerID)?.name,
          modelID: info.modelID,
          variants: info.variants,
        }
      },
      // The provider's configured name, such as "OpenAI" or "Splash".
      provider(providerID, location) {
        revision()
        syncLocation(location)
        return data.location.provider.list(location)?.find((item) => item.id === providerID)?.name ?? providerID
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
        void updateUi((draft) => {
          draft.showAll[sessionID] = !(draft.showAll[sessionID] ?? false)
        })
      },
      dispose,
    }
  })
}

// One session tree as the views show it: its runs in start order and its
// provider totals. Call it under a reactive owner; every field is a memo.
export function createSummary(tracker: Tracker, sessionID: () => string) {
  const children = createMemo(() => tracker.children(sessionID()))
  const parent = createMemo(() => tracker.messages(sessionID()))
  const calls = createMemo(() => subagentCalls(parent()))

  // Every model call in the session tree, as runs in the order they started.
  const runs = createMemo(() =>
    agentRuns([
      // The orchestrator's turns count too; each round is attributed to the agent
      // of its steps, so agent switches and compactions show as theirs.
      { sessionID: sessionID(), agent: "orchestrator", messages: parent(), newRunPerPrompt: true },
      ...children().map((child) => ({
        sessionID: child.id,
        agent: child.agent ?? "agent",
        messages: tracker.messages(child.id),
        calls: calls().filter((call) => call.sessionID === child.id),
      })),
    ]),
  )
  const providers = createMemo(() => providerUsage([parent(), ...children().map((child) => tracker.messages(child.id))]))
  const total = createMemo(() => providers().reduce((sum, usage) => sum + usage.generated, 0))
  return { runs, providers, total }
}

// What the running run does now: its last tool, else "thinking".
export function currentTool(messages: Message[]) {
  const last = messages.findLast((item) => item.type === "assistant") as SessionMessageAssistant | undefined
  const part = last?.content.findLast((item): item is SessionMessageAssistantTool => item.type === "tool")
  if (!part) return "thinking"
  const input = part.state.input
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const detail = record.description ?? record.command ?? record.filePath ?? record.path ?? record.pattern ?? ""
  const text = detail ? `${part.name} ${String(detail).split("\n")[0]}` : part.name
  return truncate(text, 60)
}
