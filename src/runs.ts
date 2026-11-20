// Pure logic: turn OpenCode session messages into agent runs and provider
// totals, and format them for a narrow sidebar. No OpenCode runtime imports,
// so the tests run on plain Bun.

export type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
export type Model = { id: string; providerID: string; variant?: string }

// The subset of OpenCode session messages this plugin reads.
export type Message =
  | { type: "user"; time: { created: number }; text: string }
  | { type: "idle"; time: { created: number }; outcome: "succeeded" | "failed" | "interrupted" }
  | { type: "synthetic"; time: { created: number }; metadata?: Record<string, unknown> }
  // Context compaction, run by the hidden compaction agent with its own model.
  | { type: "compaction"; time: { created: number }; status?: string; model?: Model; tokens?: Tokens }
  | {
      type: "assistant"
      time: { created: number; firstToken?: number; streamed?: number; completed?: number }
      agent?: string
      model: Model
      tokens?: Tokens
      content: Array<{ type: string; name?: string; state?: { input?: unknown; metadata?: unknown } }>
    }
  | { type: string; time: { created: number } }

type Assistant = Extract<Message, { type: "assistant" }>
type Compaction = Extract<Message, { type: "compaction" }>

const isAssistant = (message: Message): message is Assistant => message.type === "assistant"
const isUser = (message: Message): message is Extract<Message, { type: "user" }> => message.type === "user"
const isIdle = (message: Message): message is Extract<Message, { type: "idle" }> => message.type === "idle"
const isSynthetic = (message: Message): message is Extract<Message, { type: "synthetic" }> => message.type === "synthetic"
// A finished compaction that names its model.
const isCompaction = (message: Message): message is Compaction & { model: Model } =>
  message.type === "compaction" && !!(message as Compaction).model && (message as Compaction).status !== "running"

// Output plus reasoning: what the model generated.
export function generated(tokens: Tokens | undefined) {
  return tokens ? tokens.output + tokens.reasoning : 0
}

// First token to the end of the stream; excludes prompt processing and the
// step's tool execution (`completed` is stamped only after the tools finish).
// Falls back to `completed` for messages recorded without `streamed`.
function streamingTime(message: Assistant) {
  const { firstToken, streamed, completed } = message.time
  const end = streamed ?? completed
  return firstToken !== undefined && end !== undefined ? Math.max(0, end - firstToken) : 0
}

// Generated tokens per second of streaming; undefined when nothing streamed yet.
export function speed(generatedTokens: number, streamingMs: number) {
  return streamingMs > 0 ? generatedTokens / (streamingMs / 1000) : undefined
}

// ---- Briefs from the orchestrator ----

export type SubagentCall = { sessionID: string; description: string; prompt: string }

// Every `subagent` tool call the orchestrator made, in order, with the worker
// session it created (metadata) or re-briefed (input).
export function subagentCalls(parent: Message[]): SubagentCall[] {
  const calls: SubagentCall[] = []
  for (const message of parent) {
    if (!isAssistant(message)) continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "subagent") continue
      const input = (part.state?.input ?? {}) as Record<string, unknown>
      const metadata = (part.state?.metadata ?? {}) as Record<string, unknown>
      const sessionID = metadata.sessionID ?? input.sessionID
      if (typeof sessionID !== "string") continue
      calls.push({
        sessionID,
        description: typeof input.description === "string" ? input.description : "",
        prompt: typeof input.prompt === "string" ? input.prompt : "",
      })
    }
  }
  return calls
}

const BOILERPLATE = /^You are a subagent spawned by another session\.\s*/
const squash = (text: string) => text.replace(/\s+/g, " ").trim()
const firstLine = (text: string) => text.replace(BOILERPLATE, "").trim().split("\n")[0] ?? ""

// The orchestrator's description for a brief: the first unused call whose
// prompt the brief contains. Matching by text, not position, stays right when
// only part of a session's history is loaded.
function briefLabel(text: string, calls: Array<Omit<SubagentCall, "sessionID">>, used: Set<number>) {
  const body = squash(text)
  const index = calls.findIndex((call, at) => !used.has(at) && call.prompt && call.description && body.includes(squash(call.prompt)))
  if (index < 0) return firstLine(text)
  used.add(index)
  return calls[index]!.description
}

// ---- Rounds: one stretch of work in a session ----

export type Round = {
  // "brief": started by a prompt; "wake": the session woke on its own (a worker
  // or background job finished); "compaction": context was compacted.
  kind: "brief" | "wake" | "compaction"
  // Agent of the round's steps, when known.
  agent?: string
  label: string
  start: number
  // Undefined only for the session's last round while it still runs.
  end?: number
  outcome?: "succeeded" | "failed" | "interrupted"
  steps: number
  generated: number
  streaming: number
  // Model of the round's last step.
  model?: Model
}

// What woke an idle session: a worker finishing (seen by the orchestrator) or a
// background job.
function wakeLabel(message: Message) {
  const metadata = isSynthetic(message) ? message.metadata : undefined
  return metadata?.source === "subagent" && typeof metadata.agent === "string" ? `after ${metadata.agent}` : undefined
}

// A round starts with a prompt or with the first message after the session went
// idle, and ends at the next idle marker; this matches the "<Agent> finished"
// lines in the orchestrator's chat. Compactions are rounds of their own.
export function rounds(messages: Message[], calls: Array<Omit<SubagentCall, "sessionID">> = []): Round[] {
  const result: Round[] = []
  let current: Round | undefined
  const used = new Set<number>()
  const open = (round: Round) => {
    // A round that never saw its idle marker ends where the next one starts.
    if (current && current.end === undefined) current.end = round.start
    current = round
    result.push(round)
  }
  for (const message of messages) {
    const start = message.time.created
    if (isUser(message)) {
      open({ kind: "brief", label: briefLabel(message.text, calls, used), start, steps: 0, generated: 0, streaming: 0 })
    } else if (isCompaction(message)) {
      result.push({
        kind: "compaction",
        agent: "compaction",
        label: "compacted context",
        start,
        end: start,
        steps: 1,
        generated: generated(message.tokens),
        streaming: 0,
        model: message.model,
      })
    } else if (isIdle(message)) {
      if (current && current.end === undefined) {
        current.end = start
        current.outcome = message.outcome
      }
    } else {
      if (!current || current.end !== undefined) {
        open({ kind: "wake", label: wakeLabel(message) ?? "", start, steps: 0, generated: 0, streaming: 0 })
      }
      if (isAssistant(message)) {
        const round = current!
        round.steps += 1
        round.generated += generated(message.tokens)
        round.streaming += streamingTime(message)
        round.model = message.model
        if (message.agent) round.agent = message.agent
      }
    }
  }
  // A wake-up with no model step (a notice that only queued work) is noise.
  return result.filter((round) => round.kind !== "wake" || round.steps > 0).sort((left, right) => left.start - right.start)
}

// ---- Agent runs: the Agents section ----

export type RunSource = {
  sessionID: string
  // Fallback when a round's steps name no agent.
  agent: string
  messages: Message[]
  calls?: Array<Omit<SubagentCall, "sessionID">>
  // Every prompt starts a new run (the orchestrator: each prompt is a request).
  newRunPerPrompt?: boolean
}

// One agent's consecutive rounds: the list keeps the order agents worked in
// (A, B, A) while back-to-back briefs to one agent share a run.
export type AgentRun = {
  sessionID: string
  agent: string
  model?: Model
  start: number
  // Busy time of the finished rounds.
  busy: number
  // Start of the round still running; add `now - runningSince` to `busy`.
  runningSince?: number
  generated: number
  streaming: number
  tasks: string[]
  // Wake-ups after a background job.
  jobs: number
  failed: boolean
}

export function agentRuns(sources: RunSource[]): AgentRun[] {
  const entries = sources
    .flatMap((source) =>
      rounds(source.messages, source.calls).map((round) => ({
        sessionID: source.sessionID,
        agent: round.agent ?? source.agent,
        round,
        newRun: source.newRunPerPrompt === true && round.kind === "brief",
      })),
    )
    .sort((left, right) => left.round.start - right.round.start)
  const runs: AgentRun[] = []
  for (const { sessionID, agent, round, newRun } of entries) {
    let run = runs.at(-1)
    if (!run || newRun || run.sessionID !== sessionID || run.agent !== agent) {
      run = { sessionID, agent, start: round.start, busy: 0, generated: 0, streaming: 0, tasks: [], jobs: 0, failed: false }
      runs.push(run)
    }
    if (round.end === undefined) run.runningSince = round.start
    else run.busy += round.end - round.start
    run.generated += round.generated
    run.streaming += round.streaming
    run.model = round.model ?? run.model
    run.failed = round.outcome === "failed"
    if (round.kind === "wake" && !round.label) run.jobs += 1
    else run.tasks.push(round.label)
  }
  return runs
}

// ---- Provider totals: the Providers section ----

export type ProviderUsage = {
  providerID: string
  generated: number
  // Model time of finished steps: request to last token.
  time: number
  streaming: number
  // Share of all generated tokens, 0..1.
  share: number
}

// Per provider, counted per step so variant and model switches all count.
export function providerUsage(sessions: Message[][]): ProviderUsage[] {
  const byProvider = new Map<string, ProviderUsage>()
  const entry = (model: Model) => {
    const found = byProvider.get(model.providerID)
    if (found) return found
    const created = { providerID: model.providerID, generated: 0, time: 0, streaming: 0, share: 0 }
    byProvider.set(model.providerID, created)
    return created
  }
  for (const messages of sessions) {
    for (const message of messages) {
      if (isCompaction(message)) {
        entry(message.model).generated += generated(message.tokens)
      } else if (isAssistant(message)) {
        const sum = entry(message.model)
        sum.generated += generated(message.tokens)
        if (message.time.completed !== undefined) sum.time += Math.max(0, message.time.completed - message.time.created)
        sum.streaming += streamingTime(message)
      }
    }
  }
  const all = [...byProvider.values()]
  const total = all.reduce((sum, value) => sum + value.generated, 0)
  for (const value of all) value.share = total > 0 ? value.generated / total : 0
  return all.sort((left, right) => right.generated - left.generated)
}

// ---- Model names ----

// What the plugin knows about a configured model, from OpenCode's lists.
export type ModelFacts = {
  name: string
  // Display name of the provider, such as "OpenAI" or "Splash".
  provider?: string
  modelID: string
  variants: Array<{ id: string; body?: Record<string, unknown> }>
}

// "org/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_S" -> "Qwen3.8 Flash Next IQ3_S":
// drop the org, stop at the first all-caps build tag, keep the quant.
export function shortModelID(modelID: string) {
  const [path = "", quant] = modelID.split(":")
  const base = path.split("/").at(-1) ?? path
  const kept: string[] = []
  for (const segment of base.split(/[-_ ]/)) {
    if (kept.length > 0 && /^[A-Z0-9]+$/.test(segment) && /[A-Z]/.test(segment) && !/^\d+B$/.test(segment)) break
    kept.push(segment)
  }
  return [kept.join(" "), quant].filter(Boolean).join(" ")
}

// The configured name, unless it says nothing about the model (no digit, like
// "Splash Worker"); then a short form of the model ID.
export function displayName(facts: ModelFacts | undefined, model: Model) {
  if (!facts) return model.id
  if (/\d/.test(facts.name)) return facts.name
  return shortModelID(facts.modelID) || facts.name
}

// What a variant does, from its request body: "low effort, think ≤1k".
export function variantSummary(facts: ModelFacts | undefined, variant: string | undefined) {
  if (!facts || !variant) return undefined
  const body = facts.variants.find((item) => item.id === variant)?.body ?? {}
  const parts: string[] = []
  const effort = body.reasoning_effort ?? body.reasoningEffort
  if (typeof effort === "string") parts.push(`${effort} effort`)
  const budget = body.thinking_token_budget ?? body.thinking_budget
  if (typeof budget === "number") parts.push(`think ≤${formatTokens(budget)}`)
  return parts.length > 0 ? parts.join(", ") : undefined
}

// ---- History ----

// Merge a full history with the live cache: one copy per message id, in time order.
export function mergeMessages<T extends { id?: string; time: { created: number } }>(history: T[], live: T[]) {
  const byID = new Map<string, T>()
  const anonymous: T[] = []
  for (const message of [...history, ...live]) {
    if (message.id) byID.set(message.id, message)
    else anonymous.push(message)
  }
  return [...byID.values(), ...anonymous]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => left.message.time.created - right.message.time.created || left.index - right.index)
    .map((entry) => entry.message)
}

// ---- Formatting ----

export function formatClock(ms: number) {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

// "49.6s", "27m 44s", "1h 05m", like OpenCode's own step footer.
export function formatElapsed(ms: number) {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  return `${minutes}m ${String(total % 60).padStart(2, "0")}s`
}

export function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return `${value}`
}

// "49.6s · 4k · 95 tok/s"; a zero time (compactions record none) is left out.
export function formatStats(time: number, generatedTokens: number, streamingMs: number) {
  const rate = speed(generatedTokens, streamingMs)
  return [time > 0 ? formatElapsed(time) : "", formatTokens(generatedTokens), rate === undefined ? "" : `${Math.round(rate)} tok/s`]
    .filter(Boolean)
    .join(" · ")
}

// Word-wrap to lines of at most `width` characters, the first starting with
// `first` and the rest with `rest`; words longer than a line are split.
export function wrap(text: string, width: number, first = "", rest = first) {
  const lines: string[] = []
  let line = first
  let empty = true
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let remaining = word
    while (remaining) {
      const room = width - line.length - (empty ? 0 : 1)
      if (remaining.length <= room) {
        line += (empty ? "" : " ") + remaining
        empty = false
        remaining = ""
      } else if (!empty) {
        lines.push(line)
        line = rest
        empty = true
      } else {
        line += remaining.slice(0, room)
        remaining = remaining.slice(room)
        lines.push(line)
        line = rest
      }
    }
  }
  if (!empty) lines.push(line)
  return lines
}

// Keep at most `max` lines; the last kept line ends with "…" when text was cut.
export function clamp(lines: string[], max: number, width: number) {
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  const last = kept[max - 1]!
  kept[max - 1] = last.length < width ? `${last}…` : `${last.slice(0, width - 1)}…`
  return kept
}

export function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}
