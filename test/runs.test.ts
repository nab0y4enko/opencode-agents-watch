import { describe, expect, test } from "bun:test"
import {
  agentRuns,
  clamp,
  displayName,
  formatElapsed,
  formatStats,
  formatTokens,
  mergeMessages,
  providerUsage,
  rounds,
  shortModelID,
  speed,
  subagentCalls,
  variantSummary,
  wrap,
  type Message,
  type Model,
  type ModelFacts,
} from "../src/runs"

const worker: Model = { id: "worker", providerID: "splash", variant: "lite-1k" }
const sol: Model = { id: "gpt-6.2-sol", providerID: "openai", variant: "high" }
const tokens = (output: number, input = 1000) => ({ input, output, reasoning: 10, cache: { read: 500, write: 0 } })

const user = (at: number, text: string): Message => ({ type: "user", time: { created: at }, text })
const step = (at: number, output: number, model: Model = worker, agent?: string): Message => ({
  type: "assistant",
  time: { created: at, completed: at + 1 },
  agent,
  model,
  tokens: tokens(output),
  content: [],
})
const idle = (at: number, outcome: "succeeded" | "failed" = "succeeded"): Message => ({ type: "idle", time: { created: at }, outcome })
const synthetic = (at: number): Message => ({ type: "synthetic", time: { created: at } })
const finished = (at: number, agent: string): Message => ({
  type: "synthetic",
  time: { created: at },
  metadata: { source: "subagent", agent, state: "completed" },
})
// Orchestrator subagent calls as [prompt, description] pairs.
const calls = (...pairs: Array<[string, string]>) => pairs.map(([prompt, description]) => ({ prompt, description }))

describe("rounds", () => {
  test("a re-briefed session yields one round per brief, labelled by the orchestrator", () => {
    const messages = [
      user(0, "You are a subagent spawned by another session.\nImplement the change"),
      synthetic(1),
      step(2, 100),
      step(3, 200),
      idle(60_000),
      user(70_000, "Resume same task."),
      step(71_000, 50),
      idle(90_000),
    ]
    const result = rounds(messages, calls(["Implement the change", "Remove custom accent colors"], ["Resume same task.", "Finish accent rules"]))
    expect(result.map((round) => [round.kind, round.label, round.steps, round.generated, round.end])).toEqual([
      ["brief", "Remove custom accent colors", 2, 320, 60_000],
      ["brief", "Finish accent rules", 1, 60, 90_000],
    ])
  })

  test("tasks match briefs by prompt text, even when earlier briefs are not loaded", () => {
    const messages = [user(70_000, "Resume same task.\nFix review notes"), step(71_000, 50), idle(90_000)]
    const result = rounds(messages, calls(["Implement the change", "Remove"], ["Resume same task. Fix review notes", "Finish"]))
    expect(result[0]!.label).toBe("Finish")
  })

  test("without a matching call the brief's first line, minus the boilerplate, is the label", () => {
    const result = rounds([user(0, "You are a subagent spawned by another session.\nVerify it\nmore"), idle(5)])
    expect(result[0]!.label).toBe("Verify it")
  })

  test("wake-ups: a finished worker is named, a background job is not, an empty notice is dropped", () => {
    const result = rounds([user(0, "Go"), step(1, 1), idle(2), finished(3, "implementer"), step(4, 1), idle(5), synthetic(6), step(7, 1), idle(8), synthetic(9), idle(10)])
    expect(result.map((round) => [round.kind, round.label])).toEqual([
      ["brief", "Go"],
      ["wake", "after implementer"],
      ["wake", ""],
    ])
  })

  test("only the last round can be open; a round missing its idle marker ends at the next one", () => {
    const result = rounds([user(0, "One"), step(1, 1), user(50, "Two"), step(51, 1)])
    expect(result.map((round) => round.end)).toEqual([50, undefined])
  })

  test("a compaction is its own round with its model and tokens", () => {
    const luna: Model = { id: "gpt-6-luna", providerID: "openai" }
    const result = rounds([user(0, "Go"), step(1, 1), { type: "compaction", time: { created: 5 }, status: "completed", model: luna, tokens: tokens(300) }, step(6, 1), idle(9)])
    expect(result.map((round) => [round.kind, round.agent, round.model?.id, round.generated])).toEqual([
      ["brief", undefined, "worker", 22],
      ["compaction", "compaction", "gpt-6-luna", 310],
    ])
  })

  test("streaming time counts first token to completion only", () => {
    const timed: Message = { type: "assistant", time: { created: 0, firstToken: 3000, completed: 5000 }, model: worker, tokens: tokens(190), content: [] }
    const result = rounds([user(0, "Go"), timed, idle(6000)])
    expect(result[0]!.streaming).toBe(2000)
    expect(speed(result[0]!.generated, result[0]!.streaming)).toBe(100)
    expect(speed(10, 0)).toBeUndefined()
  })
})

describe("agentRuns", () => {
  test("orchestrator turns, workers and compactions become runs in the order they started", () => {
    const luna: Model = { id: "gpt-6-luna", providerID: "openai" }
    const build = [user(0, "Remove custom accents"), step(1, 50, sol, "build"), idle(20), finished(100, "implementer"), step(101, 20, sol, "build"), idle(120)]
    const implementer: Message[] = [
      user(20, "brief"),
      step(21, 40),
      { type: "compaction", time: { created: 60 }, status: "completed", model: luna, tokens: tokens(300) },
      step(61, 30),
      idle(100),
    ]
    const runs = agentRuns([
      { sessionID: "p", agent: "orchestrator", messages: build, newRunPerPrompt: true },
      { sessionID: "a", agent: "implementer", messages: implementer, calls: calls(["brief", "Remove"]) },
    ])
    expect(runs.map((run) => [run.agent, run.model?.id, run.tasks])).toEqual([
      ["build", "gpt-6.2-sol", ["Remove custom accents"]],
      ["implementer", "worker", ["Remove"]],
      ["compaction", "gpt-6-luna", ["compacted context"]],
      ["build", "gpt-6.2-sol", ["after implementer"]],
    ])
  })

  test("back-to-back briefs share a run; another agent in between starts a new one", () => {
    const implementer = [user(0, "a"), step(1, 10), idle(100), user(100, "b"), step(101, 20), idle(150), user(300, "e"), step(301, 5)]
    const validator = [user(150, "c"), step(151, 30), idle(200), synthetic(210), step(211, 5), idle(230)]
    const runs = agentRuns([
      { sessionID: "a", agent: "implementer", messages: implementer, calls: calls(["a", "Remove"], ["b", "Finish"], ["e", "Tidy"]) },
      { sessionID: "b", agent: "validator", messages: validator, calls: calls(["c", "Verify"]) },
    ])
    expect(runs.map((run) => [run.agent, run.tasks, run.jobs, run.start, run.busy, run.runningSince, run.generated])).toEqual([
      ["implementer", ["Remove", "Finish"], 0, 0, 150, undefined, 50],
      ["validator", ["Verify"], 1, 150, 70, undefined, 55],
      ["implementer", ["Tidy"], 0, 300, 0, 300, 15],
    ])
  })

  test("each prompt to the orchestrator starts a new run", () => {
    const build = [user(0, "First request"), step(1, 5), idle(10), user(500, "Second request"), step(501, 5), idle(510)]
    const runs = agentRuns([{ sessionID: "p", agent: "build", messages: build, newRunPerPrompt: true }])
    expect(runs.map((run) => run.tasks)).toEqual([["First request"], ["Second request"]])
  })

  test("a run is failed when its last round failed", () => {
    const runs = agentRuns([{ sessionID: "a", agent: "implementer", messages: [user(0, "Go"), step(1, 1), idle(5, "failed")] }])
    expect(runs[0]!.failed).toBe(true)
  })
})

describe("providerUsage", () => {
  test("sums tokens, model time and streaming per provider across models and variants, with shares", () => {
    const luna: Model = { id: "gpt-6-luna", providerID: "openai" }
    const timed = (created: number, completed: number | undefined, model: Model, output: number): Message => ({
      type: "assistant",
      time: { created, firstToken: created, completed },
      model,
      tokens: tokens(output),
      content: [],
    })
    const usage = providerUsage([
      [timed(0, 1000, sol, 90), timed(2000, 2500, { ...sol, variant: "medium" }, 40)],
      [timed(0, 4000, worker, 780), { type: "compaction", time: { created: 5 }, status: "completed", model: luna, tokens: tokens(40) }, timed(9000, undefined, worker, 0)],
    ])
    expect(usage).toEqual([
      // Each step adds 10 reasoning tokens; the open step counts no time yet.
      { providerID: "splash", generated: 800, time: 4000, streaming: 4000, share: 0.8 },
      { providerID: "openai", generated: 200, time: 1500, streaming: 1500, share: 0.2 },
    ])
    expect(providerUsage([])).toEqual([])
  })
})

describe("subagentCalls", () => {
  test("reads the worker session from metadata on launch and from input on re-brief", () => {
    const parent: Message[] = [
      {
        type: "assistant",
        time: { created: 0 },
        model: sol,
        content: [
          { type: "text" },
          { type: "tool", name: "subagent", state: { input: { agent: "implementer", description: "Remove", prompt: "Do it" }, metadata: { sessionID: "ses_a" } } },
          { type: "tool", name: "subagent", state: { input: { agent: "implementer", sessionID: "ses_a", description: "Finish" } } },
          { type: "tool", name: "shell", state: { input: { command: "ls" } } },
        ],
      },
    ]
    expect(subagentCalls(parent)).toEqual([
      { sessionID: "ses_a", description: "Remove", prompt: "Do it" },
      { sessionID: "ses_a", description: "Finish", prompt: "" },
    ])
  })
})

describe("models", () => {
  const facts: ModelFacts = {
    name: "Splash Worker",
    provider: "Splash",
    modelID: "ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_S",
    variants: [
      { id: "lite-1k", body: { reasoning_effort: "low", thinking_token_budget: 1024 } },
      { id: "lite-512", body: { reasoning_effort: "low", thinking_budget: 512 } },
      { id: "deep", body: { reasoning_effort: "xhigh" } },
    ],
  }
  const solFacts: ModelFacts = { name: "GPT-6.2 Sol", provider: "OpenAI", modelID: "gpt-6.2-sol", variants: [{ id: "high" }] }

  test("a generic configured name falls back to a short form of the model ID", () => {
    expect(displayName(facts, worker)).toBe("Qwen3.8 Flash Next IQ3_S")
    expect(displayName(solFacts, sol)).toBe("GPT-6.2 Sol")
    expect(displayName(undefined, worker)).toBe("worker")
    expect(shortModelID("google/gemma-4-27B-it-GGUF:Q4_K_M")).toBe("gemma 4 27B it Q4_K_M")
  })

  test("variant summary says what the variant does", () => {
    expect(variantSummary(facts, "lite-1k")).toBe("low effort, think ≤1k")
    expect(variantSummary(facts, "lite-512")).toBe("low effort, think ≤512")
    expect(variantSummary(facts, "deep")).toBe("xhigh effort")
    expect(variantSummary(solFacts, "high")).toBeUndefined()
    expect(variantSummary(facts, undefined)).toBeUndefined()
  })
})

describe("history", () => {
  test("merging full history with the live cache keeps one copy in time order", () => {
    const a = { id: "1", time: { created: 1 } }
    const b = { id: "2", time: { created: 2 } }
    const bLive = { id: "2", time: { created: 2 }, updated: true }
    const c = { id: "3", time: { created: 3 } }
    expect(mergeMessages<{ id: string; time: { created: number }; updated?: boolean }>([a, b], [bLive, c])).toEqual([a, bLive, c])
  })
})

describe("formatting", () => {
  test("numbers and times", () => {
    expect(formatTokens(950)).toBe("950")
    expect(formatTokens(12_400)).toBe("12k")
    expect(formatTokens(12_700_000)).toBe("12.7m")
    expect(formatElapsed(49_600)).toBe("49.6s")
    expect(formatElapsed(1_664_000)).toBe("27m 44s")
    expect(formatElapsed(3_900_000)).toBe("1h 05m")
  })

  test("stats line reads like OpenCode's step footer and drops a zero time", () => {
    expect(formatStats(49_600, 1700, 47_600)).toBe("49.6s · 2k · 36 tok/s")
    expect(formatStats(0, 3000, 0)).toBe("3k")
  })

  test("wraps words to the width with prefixes and splits long words", () => {
    expect(wrap("Independently recheck only follow-up commits ca5a976a", 20, "  1. ", "     ")).toEqual([
      "  1. Independently",
      "     recheck only",
      "     follow-up",
      "     commits",
      "     ca5a976a",
    ])
    expect(wrap("ISTA-DASLab/Qwen3.8-Flash", 10, "  ")).toEqual(["  ISTA-DAS", "  Lab/Qwen", "  3.8-Flas", "  h"])
    expect(wrap("", 10, "  ")).toEqual([])
  })

  test("clamp keeps two lines and marks the cut", () => {
    const lines = wrap("Independently recheck only follow-up commits ca5a976a and e976ca7b", 20, "  ", "  ")
    expect(clamp(lines, 2, 20)).toEqual(["  Independently", "  recheck only…"])
    expect(clamp(["  short"], 2, 20)).toEqual(["  short"])
    expect(clamp(["  aaaaaaaaaaaaaaaaaa", "  bbbbbbbbbbbbbbbbbb", "  c"], 2, 20)).toEqual(["  aaaaaaaaaaaaaaaaaa", "  bbbbbbbbbbbbbbbbb…"])
  })
})
