import { expect, test } from "bun:test"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import type { Invocation } from "@vibe-llm/protocols/common"
import type { MessagesStreamEvent } from "@vibe-llm/protocols/messages"
import { prepareLokiForcedSearch, requireLokiSearchCall } from "../../../../../src/data-plane/chat-flow/messages/interceptors/loki-forced-web-search"

type Frame = ProtocolFrame<MessagesStreamEvent>
const text = (value: string): Frame => eventFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } })
const search: Frame = eventFrame({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "search", name: "web_search", input: {} } })
async function* frames(values: Frame[]): AsyncGenerator<Frame> { yield* values }
async function collect(values: AsyncIterable<Frame>): Promise<Frame[]> {
  const out: Frame[] = []
  for await (const value of values) out.push(value)
  return out
}
const withoutPings = (values: Frame[]) => values.filter(f => f.type !== "event" || f.event.type !== "ping")

test("buffers the prelude until a matching search tool call", async () => {
  const prelude = text("prelude")
  const output = withoutPings(await collect(requireLokiSearchCall(frames([prelude, search, { type: "done" }]))))
  expect(output).toEqual([prelude, search, { type: "done" }])
})

test("bounded prelude aborts and closes upstream without exposing text or success", async () => {
  let aborted = false
  let closed = false
  async function* upstream(): AsyncGenerator<Frame> {
    try { yield text("private".repeat(50000)); yield search }
    finally { closed = true }
  }
  const output = withoutPings(await collect(requireLokiSearchCall(upstream(), () => { aborted = true })))
  expect(aborted).toBe(true)
  expect(closed).toBe(true)
  expect(output).toHaveLength(1)
  expect(output[0]).toMatchObject({ type: "event", event: { type: "error", error: { type: "api_error" } } })
  expect(JSON.stringify(output)).not.toContain("private")
})

test("upstream error discards unverified text and closes before later tools", async () => {
  const error: Frame = eventFrame({ type: "error", error: { type: "api_error", message: "fixture" } })
  const output = withoutPings(await collect(requireLokiSearchCall(frames([text("private"), error, search]))))
  expect(output).toEqual([error])
})

test("consumer cancellation at a ping closes the upstream iterator", async () => {
  let closed = false
  async function* upstream(): AsyncGenerator<Frame> {
    try { yield eventFrame({ type: "ping" }); yield search }
    finally { closed = true }
  }
  const guarded = requireLokiSearchCall(upstream())
  expect((await guarded.next()).value).toMatchObject({ event: { type: "ping" } })
  await guarded.return(undefined)
  expect(closed).toBe(true)
})

test("only native Messages Opus search is adapted, and invalid system is preserved", () => {
  const original = { model: "claude-opus-5.5", tools: [{ type: "web_search_20250305", name: "web_search" }], tool_choice: { type: "tool", name: "web_search" } }
  for (const sourceApi of ["gemini", "responses", "chat_completions"] as const) {
    const invocation: Invocation = { endpoint: "messages", sourceApi, enabledFlags: new Set(), headers: {}, payload: { ...original } }
    expect(prepareLokiForcedSearch(invocation, { upstreamKind: "loki", requestStartedAt: 0 }, original)).toBe(false)
    expect(invocation.payload).toEqual(original)
  }
  const invocation: Invocation = { endpoint: "messages", enabledFlags: new Set(), headers: {}, payload: { ...original, system: 42 } }
  expect(prepareLokiForcedSearch(invocation, { upstreamKind: "loki", requestStartedAt: 0 }, original)).toBe(false)
  expect(invocation.payload.system).toBe(42)
})
