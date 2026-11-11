import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  appendText, applyCitations, applyWebSearchProgress, compactMessages, composeSystemPrompt, dropEmptyAssistant,
  dropLastUserTurn, finalizeLast, hostOf, loadPersistedMessages, loadPersistedProtocol, messageParts,
  retryPlan, setLastImages, setLastOutput, setLastUsage, toggleIndex, type Message,
} from "./chat-state"

const user = (text: string): Message => ({ role: "user", text })
const assistant = (text: string, extra: Partial<Message> = {}): Message => ({ role: "assistant", text, ...extra })

describe("trailing-assistant reducers", () => {
  test("appendText grows the last assistant turn", () => {
    const prev = [user("q"), assistant("he")]
    expect(appendText(prev, "llo")).toEqual([user("q"), assistant("hello")])
  })

  test("reducers leave the thread alone when the last turn is not an assistant", () => {
    const prev = [user("q")]
    expect(appendText(prev, "x")).toBe(prev)
    expect(setLastUsage(prev, { input_tokens: 1, output_tokens: 2 })).toBe(prev)
    expect(setLastOutput(prev, { protocol: "openai", message: {} })).toBe(prev)
    expect(setLastImages(prev, [], undefined)).toBe(prev)
    expect(finalizeLast(prev, 10, undefined)).toBe(prev)
    expect(applyWebSearchProgress(prev, { status: "searching" })).toBe(prev)
    expect(applyCitations(prev, [{ url: "https://a" }])).toBe(prev)
    const empty: Message[] = []
    expect(appendText(empty, "x")).toBe(empty)
  })

  test("setLastUsage / setLastOutput replace only their field", () => {
    const prev = [assistant("a", { model: "m" })]
    expect(setLastUsage(prev, { input_tokens: 1, output_tokens: 2 })[0]).toEqual(
      assistant("a", { model: "m", usage: { input_tokens: 1, output_tokens: 2 } }),
    )
    expect(setLastOutput(prev, { protocol: "anthropic", content: [] })[0]!.output).toEqual({ protocol: "anthropic", content: [] })
  })

  test("setLastImages adds usage only when reported", () => {
    const parts = [{ type: "image" as const, dataUrl: "data:x", id: "i" }]
    expect(setLastImages([assistant("")], parts, undefined)[0]).toEqual(assistant("", { parts }))
    expect(setLastImages([assistant("")], parts, { input_tokens: 3, output_tokens: 0 })[0]!.usage).toEqual({ input_tokens: 3, output_tokens: 0 })
  })

  test("finalizeLast stamps the duration and, when observed, the performance", () => {
    expect(finalizeLast([assistant("a")], 42, undefined)[0]).toEqual(assistant("a", { durationMs: 42 }))
    const snapshot = { outcome: "success" as const, responses: 1, outputChunks: 1, metrics: {} }
    expect(finalizeLast([assistant("a")], 42, snapshot)[0]).toEqual(assistant("a", { durationMs: 42, performance: snapshot }))
  })
})

describe("applyWebSearchProgress", () => {
  test("adds entries keyed by item_id and merges later updates in place", () => {
    let thread = [assistant("")]
    thread = applyWebSearchProgress(thread, { status: "in_progress", item_id: "a" })
    thread = applyWebSearchProgress(thread, { status: "in_progress", item_id: "b", query: "q2" })
    thread = applyWebSearchProgress(thread, { status: "completed", item_id: "a", query: "q1" })
    expect(thread[0]!.webSearches).toEqual([
      { id: "a", status: "completed", query: "q1" },
      { id: "b", status: "in_progress", query: "q2" },
    ])
  })

  test("keeps an earlier query when an update carries none", () => {
    let thread = [assistant("")]
    thread = applyWebSearchProgress(thread, { status: "searching", item_id: "a", query: "q" })
    thread = applyWebSearchProgress(thread, { status: "completed", item_id: "a" })
    expect(thread[0]!.webSearches).toEqual([{ id: "a", status: "completed", query: "q" }])
  })

  test("synthesizes an id from the count when the upstream gives none", () => {
    let thread = [assistant("")]
    thread = applyWebSearchProgress(thread, { status: "searching" })
    thread = applyWebSearchProgress(thread, { status: "searching" })
    expect(thread[0]!.webSearches!.map((w) => w.id)).toEqual(["ws_0", "ws_1"])
  })
})

test("applyCitations dedupes by URL and keeps arrival order", () => {
  let thread = [assistant("")]
  thread = applyCitations(thread, [{ url: "https://a", title: "A" }, { url: "https://b" }])
  thread = applyCitations(thread, [{ url: "https://a", title: "A again" }, { url: "https://c" }])
  expect(thread[0]!.citations).toEqual([{ url: "https://a", title: "A" }, { url: "https://b" }, { url: "https://c" }])
})

describe("dropEmptyAssistant", () => {
  test("drops a trailing assistant with neither text nor parts", () => {
    expect(dropEmptyAssistant([user("q"), assistant("")])).toEqual([user("q")])
  })
  test("keeps an assistant that produced something", () => {
    const prev = [user("q"), assistant("partial")]
    expect(dropEmptyAssistant(prev)).toBe(prev)
    const withParts = [user("q"), assistant("", { parts: [{ type: "image", dataUrl: "" }] })]
    expect(dropEmptyAssistant(withParts)).toBe(withParts)
  })
})

describe("dropLastUserTurn", () => {
  test("cuts the last user turn and everything after it", () => {
    expect(dropLastUserTurn([user("a"), assistant("1"), user("b"), assistant("")])).toEqual([user("a"), assistant("1")])
  })
  test("a thread without a user turn empties", () => {
    expect(dropLastUserTurn([assistant("x")])).toEqual([])
  })
})

describe("retryPlan", () => {
  const parts = (text: string) => [{ type: "text" as const, text }]
  test("a failed first turn re-sends its parts on an empty base", () => {
    const u1: Message = { role: "user", text: "hi", parts: parts("hi") }
    expect(retryPlan([u1, assistant("partial")])).toEqual({ base: [], parts: parts("hi") })
  })
  test("a failed turn with no assistant bubble left re-sends on the earlier history", () => {
    expect(retryPlan([user("a"), assistant("1"), user("b")])).toEqual({ base: [user("a"), assistant("1")], parts: parts("b") })
  })
  test("keeps the earlier exchanges and drops only the failed turn and its reply", () => {
    const u0 = user("a"), a0 = assistant("1")
    expect(retryPlan([u0, a0, user("b"), assistant("", { durationMs: 5 })])).toEqual({ base: [u0, a0], parts: parts("b") })
  })
  test("the base never contains the re-sent user turn, so the request carries it once", () => {
    const plan = retryPlan([user("a"), assistant("1"), user("b"), assistant("x")])!
    const next = [...plan.base, { role: "user" as const, text: "b", parts: plan.parts }]
    expect(next.filter((m) => m.role === "user" && m.text === "b")).toHaveLength(1)
  })
  test("is null when there is nothing to retry", () => {
    expect(retryPlan([])).toBeNull()
    expect(retryPlan([assistant("x")])).toBeNull()
    expect(retryPlan([user("")])).toBeNull()
  })
})

describe("compactMessages", () => {
  test("is null for a thread of two or fewer", () => {
    expect(compactMessages([user("a"), assistant("1")])).toBeNull()
  })
  test("drops up to four messages from the first user turn", () => {
    const prev = [user("a"), assistant("1"), user("b"), assistant("2"), user("c"), assistant("3")]
    expect(compactMessages(prev)).toEqual([user("c"), assistant("3")])
  })
  test("never drops below two messages", () => {
    expect(compactMessages([user("a"), assistant("1"), user("b")])).toEqual([assistant("1"), user("b")])
  })
  test("starts the cut at a user turn", () => {
    const prev = [assistant("0"), user("a"), assistant("1"), user("b"), assistant("2")]
    expect(compactMessages(prev)).toEqual([assistant("0"), assistant("2")])
  })
})

test("toggleIndex flips membership without mutating", () => {
  const a = new Set([1])
  expect([...toggleIndex(a, 2)].sort()).toEqual([1, 2])
  expect([...toggleIndex(a, 1)]).toEqual([])
  expect([...a]).toEqual([1])
})

test("messageParts prefers parts and falls back to text", () => {
  expect(messageParts(user("hi"))).toEqual([{ type: "text", text: "hi" }])
  expect(messageParts(user(""))).toEqual([])
  expect(messageParts({ role: "user", text: "x", parts: [] })).toEqual([])
})

test("hostOf strips www and survives bad URLs", () => {
  expect(hostOf("https://www.example.com/a")).toBe("example.com")
  expect(hostOf("not a url")).toBe("not a url")
})

test("composeSystemPrompt puts the time line first", () => {
  expect(composeSystemPrompt("  ")).toMatch(/^Current time: \S+ \(.+, timezone .+\)\.$/)
  expect(composeSystemPrompt(" Be brief ")).toMatch(/^Current time: .+\n\nBe brief$/)
})

describe("persisted state", () => {
  const store = new Map<string, string>()
  const g = globalThis as Record<string, unknown>
  const had = "localStorage" in g
  const original = g.localStorage
  beforeEach(() => {
    store.clear()
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null }
  })
  afterEach(() => {
    if (had) g.localStorage = original
    else delete g.localStorage
  })

  test("protocol defaults to openai unless a known one is stored", () => {
    expect(loadPersistedProtocol()).toBe("openai")
    store.set("playground.protocol", "gemini")
    expect(loadPersistedProtocol()).toBe("gemini")
    store.set("playground.protocol", "bogus")
    expect(loadPersistedProtocol()).toBe("openai")
  })

  test("messages: bad JSON or non-arrays load as empty", () => {
    store.set("playground.messages", "{oops")
    expect(loadPersistedMessages()).toEqual([])
    store.set("playground.messages", "{}")
    expect(loadPersistedMessages()).toEqual([])
  })

  test("messages: a trailing empty assistant bubble is dropped, one with performance kept", () => {
    store.set("playground.messages", JSON.stringify([user("q"), assistant("")]))
    expect(loadPersistedMessages()).toEqual([user("q")])
    const perf = { outcome: "cancelled", responses: 1, outputChunks: 0, metrics: {} }
    store.set("playground.messages", JSON.stringify([user("q"), assistant("", { performance: perf as Message["performance"] })]))
    expect(loadPersistedMessages()).toHaveLength(2)
  })

  test("messages: legacy imageUrl migrates to a trailing image part", () => {
    store.set("playground.messages", JSON.stringify([{ role: "user", text: "see", imageUrl: "data:x" }]))
    expect(loadPersistedMessages()).toEqual([
      { role: "user", text: "see", parts: [{ type: "text", text: "see" }, { type: "image", dataUrl: "data:x" }] },
    ])
  })
})
