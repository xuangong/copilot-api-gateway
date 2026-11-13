import { afterEach, beforeEach, expect, test } from "bun:test"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { llmEventResult } from "@vibe-llm/protocols/common"
import type { ResponsesResult, ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { createResponsesTurn, type CompletedResponsesSnapshot } from "../../../../src/data-plane/chat-flow/responses/turn.ts"
import { setupTestPlatform } from "../../../_setup-platform.ts"
import { AffinityCodec } from "../../../../src/shared/affinity/carrier.ts"

let platform: ReturnType<typeof setupTestPlatform>
beforeEach(() => { platform = setupTestPlatform() })
afterEach(() => platform.db.close())
const identity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "test", cost: null }
const response: ResponsesResult = { id: "r", object: "response", model: "m", status: "in_progress", output: [], error: null, incomplete_details: null }
const created: ResponsesStreamEvent = { type: "response.created", response }
const completed: ResponsesStreamEvent = { type: "response.completed", response: { ...response, status: "completed" } }

function held(events: ResponsesStreamEvent[]) {
  const pending = Promise.withResolvers<void>()
  const release = Promise.withResolvers<IteratorResult<ProtocolFrame<ResponsesStreamEvent>>>()
  let index = 0
  let returned = 0
  const source: AsyncIterableIterator<ProtocolFrame<ResponsesStreamEvent>> = {
    [Symbol.asyncIterator]() { return this },
    next: async () => {
      const event = events[index++]
      if (event) return { done: false, value: eventFrame(event) }
      pending.resolve()
      return release.promise
    },
    return: async () => { returned++; release.resolve({ done: true, value: undefined }); return { done: true, value: undefined } },
  }
  return { source, pending: pending.promise, returned: () => returned }
}

for (const stamped of [false, true]) test(`interrupt wakes a pending read, discards partial items and saves once (affinity:${stamped})`, async () => {
  const source = held([
    created,
    { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "discard" }] } },
    { type: "response.output_item.done", output_index: 1, item: { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "retain" }] } },
    { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "call", call_id: "call", name: "f", arguments: "{}", status: "completed" } },
    { type: "response.output_item.added", output_index: 3, item: { type: "function_call", id: "partial", call_id: "partial", name: "f", arguments: '{"partial":', status: "in_progress" } },
  ])
  const upstream = new AbortController()
  const saved: CompletedResponsesSnapshot[] = []
  const turn = createResponsesTurn(llmEventResult(source.source, identity), {
    wantsStream: true, upstreamAbortController: upstream, onCompleted: async value => { saved.push(value) },
    affinity: stamped ? {
      protocol: "responses",
      actual: { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "m" },
      codec: new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) }),
    } : undefined,
  })
  expect(turn.interrupt("r")).toBe(false)
  const events = Array.fromAsync(turn.events)
  await source.pending
  expect(turn.interrupt("different")).toBe(false)
  expect(upstream.signal.aborted).toBe(false)
  expect(turn.interrupt("r")).toBe(true)
  expect(turn.interrupt("r")).toBe(true)
  const wire = await events
  expect(upstream.signal.aborted).toBe(true)
  expect(turn.abortController.signal.aborted).toBe(false)
  expect(wire.filter(event => event.type === "response.completed")).toHaveLength(1)
  expect(wire.at(-1)).toMatchObject({ type: "response.completed", response: { status: "completed" } })
  expect(saved).toHaveLength(1)
  expect(JSON.stringify(saved)).toContain("retain")
  expect(JSON.stringify(saved)).not.toContain("discard")
  expect(JSON.stringify(saved)).not.toContain("partial")
  expect(saved[0]?.output).toHaveLength(stamped ? 3 : 2)
  expect(source.returned()).toBe(1)
  expect(await turn.completion).toMatchObject({ outcome: "completed", cleanupComplete: true, response: { id: "r" } })
  expect(await turn.facts).toMatchObject({ continuation: "fulfilled", rawCleanupComplete: true })
})

test("an interrupted producer that cannot close still reports incomplete cleanup", async () => {
  const source = held([created])
  source.source.return = () => new Promise(() => {})
  const turn = createResponsesTurn(llmEventResult(source.source, identity), { wantsStream: true })
  const events = Array.fromAsync(turn.events)
  await source.pending
  expect(turn.interrupt("r")).toBe(true)
  expect((await events).at(-1)?.type).toBe("response.completed")
  expect(await turn.completion).toMatchObject({ outcome: "completed", cleanupComplete: false })
  expect(await turn.facts).toMatchObject({ rawCleanupComplete: false })
})

test("disconnect after interrupt remains cancellation and cannot save a synthetic success", async () => {
  const source = held([created])
  let saved = 0
  const turn = createResponsesTurn(llmEventResult(source.source, identity), { wantsStream: true, onCompleted: async () => { saved++ } })
  const events = Array.fromAsync(turn.events)
  await source.pending
  expect(turn.interrupt("r")).toBe(true)
  turn.abortController.abort()
  expect((await events).map(event => event.type)).toEqual(["response.created"])
  expect(await turn.completion).toEqual({ outcome: "cancelled", cleanupComplete: true })
  expect(saved).toBe(0)
})

test("interrupt crossing a selected completion preserves its authoritative output and usage", async () => {
  const terminal: ResponsesStreamEvent = { ...completed, response: { ...response, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "authoritative" }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }
  const source = held([created, terminal])
  const upstream = new AbortController()
  const turn = createResponsesTurn(llmEventResult(source.source, identity), { wantsStream: true, upstreamAbortController: upstream })
  const events = Array.fromAsync(turn.events)
  await source.pending
  expect(turn.interrupt("r")).toBe(true)
  expect(upstream.signal.aborted).toBe(false)
  await source.source.return?.()
  expect((await events).at(-1)).toEqual(terminal)
  expect(await turn.completion).toMatchObject({ outcome: "completed", cleanupComplete: true })
})

test("interrupt during the completion save barrier does not duplicate or replace that save", async () => {
  const saving = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let saves = 0
  async function* source() { yield eventFrame(created); yield eventFrame(completed) }
  const turn = createResponsesTurn(llmEventResult(source(), identity), { wantsStream: true, onCompleted: async () => { saves++; saving.resolve(); await release.promise } })
  const events = Array.fromAsync(turn.events)
  await saving.promise
  expect(turn.interrupt("r")).toBe(true)
  release.resolve()
  expect((await events).filter(event => event.type === "response.completed")).toHaveLength(1)
  expect(saves).toBe(1)
  expect(await turn.completion).toMatchObject({ outcome: "completed", cleanupComplete: true })
})

test("interrupt crossing a selected incomplete terminal is acknowledged and preserves it", async () => {
  const incomplete: ResponsesStreamEvent = { type: "response.incomplete", response: { ...response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }
  const source = held([created, incomplete])
  const upstream = new AbortController()
  const turn = createResponsesTurn(llmEventResult(source.source, identity), { wantsStream: true, upstreamAbortController: upstream })
  const events = Array.fromAsync(turn.events)
  await source.pending
  expect(turn.interrupt("r")).toBe(true)
  expect(upstream.signal.aborted).toBe(false)
  await source.source.return?.()
  expect((await events).at(-1)).toMatchObject({ type: "response.incomplete" })
  expect(await turn.completion).toMatchObject({ outcome: "incomplete" })
})

test("an interrupt after the stream has failed is refused, not accepted ahead of the error", async () => {
  let reads = 0
  const source: AsyncIterableIterator<ProtocolFrame<ResponsesStreamEvent>> = {
    [Symbol.asyncIterator]() { return this },
    next: async () => {
      if (reads++ === 0) return { done: false, value: eventFrame(created) }
      throw new Error("upstream reset")
    },
    return: async () => ({ done: true, value: undefined }),
  }
  const turn = createResponsesTurn(llmEventResult(source, identity), { wantsStream: true })
  const events = turn.events[Symbol.asyncIterator]()
  expect((await events.next()).value).toMatchObject({ type: "response.created" })
  expect((await events.next()).value).toMatchObject({ type: "error" })
  expect(turn.interrupt("r")).toBe(false)
  expect((await events.next()).done).toBe(true)
  expect(await turn.completion).toMatchObject({ outcome: "failed" })
})
