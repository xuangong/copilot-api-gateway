import { beforeEach, expect, test } from "bun:test"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { llmEventResult } from "@vibe-llm/protocols/common"
import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { AffinityCodec } from "../../../../src/shared/affinity/carrier"
import { createResponsesTurn } from "../../../../src/data-plane/chat-flow/responses/turn"
import { respondResponses } from "../../../../src/data-plane/chat-flow/responses/respond"
import { setupTestPlatform } from "../../../_setup-platform"

beforeEach(() => setupTestPlatform())
type JsonObject = Record<string, unknown>
const identity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "fixture", cost: null }
const target = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "m" }
const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })
const affinity = () => ({ protocol: "responses" as const, codec, actual: target })
const item = { type: "message", id: "native", role: "assistant", content: [{ type: "output_text", text: "early" }] }
const body = { id: "response", object: "response", status: "completed", model: "m", output: [item] }
async function* frames(events: readonly unknown[]): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for (const event of events) yield eventFrame(event as ResponsesStreamEvent)
}
const input = () => frames([
  { type: "response.created", sequence_number: 40, response: { ...body, status: "in_progress", output: [] } },
  { type: "response.output_text.delta", sequence_number: 44, output_index: 5, content_index: 0, item_id: "native", delta: "early" },
  { type: "response.output_item.done", sequence_number: 48, output_index: 5, item },
  { type: "response.completed", sequence_number: 51, response: body },
])

for (const wantsStream of [false, true]) {
  test(`Responses ${wantsStream ? "SSE" : "JSON"} persists the same single origin prefix without rewriting native identity`, async () => {
    let saved: unknown
    const response = await respondResponses(llmEventResult(input(), identity), { wantsStream, affinity: affinity(), onCompleted: async value => { saved = value.output } })
    const wire = await response.text()
    const events: JsonObject[] = wantsStream ? wire.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as JsonObject) : []
    const final = wantsStream ? events.at(-1)?.response as typeof body : JSON.parse(wire) as typeof body
    const output = final.output as unknown as JsonObject[]
    expect(output).toHaveLength(2)
    expect(output[0]).toMatchObject({ type: "reasoning", summary: [] })
    expect(output[0]?.id).toBeString()
    expect(output[0]?.encrypted_content).toStartWith("vnext-affinity:2:")
    expect(output[1]).toEqual(item)
    expect(saved).toEqual(output)
    if (wantsStream) {
      expect(events.map(event => event.type)).toEqual(["response.created", "response.output_item.added", "response.output_item.done", "response.output_text.delta", "response.output_item.done", "response.completed"])
      expect(events.map(event => event.sequence_number)).toEqual([0, 1, 2, 3, 4, 5])
      expect((events[0]?.response as JsonObject).output).toEqual([])
      expect(events[1]).toMatchObject({ output_index: 0, item: output[0] })
      expect(events[2]).toMatchObject({ output_index: 0, item: output[0] })
      expect(events[3]).toMatchObject({ output_index: 6, content_index: 0, item_id: "native", delta: "early" })
      expect(events[4]).toMatchObject({ output_index: 6, item })
    }
  })
}

test("terminal-only Responses with natural state still has one independent v2 prefix", async () => {
  const natural = { type: "reasoning", id: "natural", summary: [], encrypted_content: "native-state" }
  const turn = createResponsesTurn(llmEventResult(frames([{ type: "response.completed", response: { ...body, output: [natural] } }]), identity), { wantsStream: true, affinity: affinity() })
  const events = await Array.fromAsync(turn.events)
  const last = events.at(-1)
  if (!last || last.type !== "response.completed") throw new Error("Missing completion")
  expect(last.response.output).toHaveLength(2)
  expect(last.response.output[0]).toMatchObject({ type: "reasoning", summary: [] })
  expect((last.response.output[0] as JsonObject).encrypted_content).toStartWith("vnext-affinity:2:")
  expect((last.response.output[1] as JsonObject).encrypted_content).toStartWith("vnext-affinity:1:")
  expect(last.response.output[1]?.id).toBe("natural")
})

test("canonical turn withholds completed until the prefixed snapshot is saved", async () => {
  const saving = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let saved: unknown
  const turn = createResponsesTurn(llmEventResult(input(), identity), {
    wantsStream: true, affinity: affinity(), onCompleted: async response => { saved = response.output; saving.resolve(); await release.promise },
  })
  const seen: ResponsesStreamEvent[] = []
  const reading = (async () => { for await (const event of turn.events) seen.push(event) })()
  await saving.promise
  try {
    expect(seen.some(event => event.type === "response.completed")).toBe(false)
    expect(saved).toBeArrayOfSize(2)
  } finally { release.resolve() }
  await reading
  const final = seen.at(-1)
  if (!final || final.type !== "response.completed") throw new Error("Missing completion")
  expect(final.response.output).toEqual(saved)
  expect((await turn.completion).response?.output).toEqual(saved)
})

test("empty completed Responses still persists its single origin prefix", async () => {
  let saved: unknown
  const turn = createResponsesTurn(llmEventResult(frames([{ type: "response.completed", response: { ...body, output: [] } }]), identity), { wantsStream: true, affinity: affinity(), onCompleted: async value => { saved = value.output } })
  const events = await Array.fromAsync(turn.events)
  const final = events.at(-1)
  if (!final || final.type !== "response.completed") throw new Error("Missing completion")
  expect(final.response.output).toHaveLength(1)
  expect(saved).toEqual(final.response.output)
  expect(events.map(event => event.type)).toEqual(["response.output_item.added", "response.output_item.done", "response.completed"])
})

test("Responses in_progress retains the already emitted prefix for SDK snapshot replacement", async () => {
  const start = { ...body, status: "in_progress", output: [] }
  const turn = createResponsesTurn(llmEventResult(frames([
    { type: "response.created", response: start },
    { type: "response.in_progress", response: start },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: body },
  ]), identity), { wantsStream: true, affinity: affinity() })
  const events = await Array.fromAsync(turn.events)
  let output: unknown[] = []
  for (const event of events) {
    if (event.type === "response.created" || event.type === "response.in_progress" || event.type === "response.completed") output = [...event.response.output]
    if (event.type === "response.output_item.added") {
      expect(event.output_index).toBe(output.length)
      output.push(event.item)
    }
    if (event.type === "response.output_item.done") output[event.output_index] = event.item
  }
  expect(output).toHaveLength(2)
  expect(output[1]).toEqual(item)
})

test("failed, incomplete and error-only Responses never become reusable snapshots", async () => {
  for (const type of ["response.failed", "response.incomplete", "error"]) {
    let saves = 0
    const event = type === "error" ? { type, message: "upstream failed" } : { type, response: { ...body, status: type.slice(9) } }
    const turn = createResponsesTurn(llmEventResult(frames([event]), identity), { wantsStream: true, affinity: affinity(), onCompleted: async () => { saves++ } })
    const output = await Array.fromAsync(turn.events)
    expect(saves).toBe(0)
    expect((await turn.completion).response).toBeUndefined()
    if (type !== "response.incomplete") expect(output.map(item => item.type)).toEqual([type])
  }
})

test("cancelled Responses closes its upstream after the prefix without persisting", async () => {
  let consumed = 0
  let closed = false
  let saves = 0
  async function* paced() {
    try {
      for await (const event of input()) { consumed++; yield event }
    } finally { closed = true }
  }
  const turn = createResponsesTurn(llmEventResult(paced(), identity), { wantsStream: true, affinity: affinity(), onCompleted: async () => { saves++ } })
  const first = await turn.events.next()
  expect(first.value?.type).toBe("response.created")
  await turn.events.return(undefined)
  await turn.completion
  expect(consumed).toBe(1)
  expect(closed).toBe(true)
  expect(saves).toBe(0)
})

test("terminal-only Responses stops its remaining projected events immediately on abort", async () => {
  let saves = 0
  const turn = createResponsesTurn(llmEventResult(frames([{ type: "response.completed", response: { ...body, output: [] } }]), identity), { wantsStream: true, affinity: affinity(), onCompleted: async () => { saves++ } })
  expect((await turn.events.next()).value?.type).toBe("response.output_item.added")
  expect(saves).toBe(0)
  turn.abortController.abort()
  // Queue a pull in the same turn, before the asynchronous cleanup can return
  // the generator; each projected event must still recheck cancellation.
  expect((await turn.events.next()).done).toBe(true)
  const completion = await turn.completion
  expect(completion.outcome).toBe("cancelled")
  expect(completion.response).toBeUndefined()
  expect(saves).toBe(0)
})

test("terminal-only Responses introduces its prefix before saving and still withholds completed until saved", async () => {
  const saving = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let saves = 0
  const turn = createResponsesTurn(llmEventResult(frames([{ type: "response.completed", response: { ...body, output: [] } }]), identity), {
    wantsStream: true, affinity: affinity(), onCompleted: async () => { saves++; saving.resolve(); await release.promise },
  })
  expect((await turn.events.next()).value?.type).toBe("response.output_item.added")
  expect(saves).toBe(0)
  expect((await turn.events.next()).value?.type).toBe("response.output_item.done")
  expect(saves).toBe(0)
  let delivered = false
  const last = turn.events.next().then(value => { delivered = true; return value })
  await saving.promise
  try { expect(delivered).toBe(false) }
  finally { release.resolve() }
  expect((await last).value?.type).toBe("response.completed")
  await turn.events.next()
  expect((await turn.completion).outcome).toBe("completed")
})
