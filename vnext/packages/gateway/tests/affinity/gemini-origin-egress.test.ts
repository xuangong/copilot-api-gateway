import { expect, test } from "bun:test"
import { AffinityCodec } from "../../src/shared/affinity/carrier"
import { AffinityEgress } from "../../src/shared/affinity/egress"
import { analyzeAffinityRequest } from "../../src/shared/affinity/analysis"

type JsonObject = Record<string, unknown>
type Part = JsonObject
interface Event { candidates?: Array<{ index?: number; content: { role?: string; parts: Part[] }; finishReason?: string; [key: string]: unknown }>; [key: string]: unknown }
const target = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "executed" }
const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })
const state = () => ({ protocol: "gemini" as const, actual: target, codec })
type Candidate = NonNullable<Event["candidates"]>[number]
const event = (parts: Part[], finishReason?: string, index = 0): Event & { candidates: [Candidate] } => ({ candidates: [{ index, content: { role: "model", parts }, ...(finishReason === undefined ? {} : { finishReason }) }] })
async function* values<T>(items: readonly T[]): AsyncGenerator<T> { yield* items }
const parts = (events: readonly Event[]) => events.flatMap(event => event.candidates?.flatMap(candidate => candidate.content.parts) ?? [])
const stream = async (events: readonly Event[]): Promise<Event[]> => await Array.fromAsync(new AffinityEgress(state()).gemini(values(events))) as Event[]

test("Gemini JSON uses content-bearing metadata and preserves merged text on origin consumption", async () => {
  const input: Event = { candidates: [event([{ text: "answer" }], "STOP").candidates[0], event([{ text: "natural", thoughtSignature: "" }], "STOP", 1).candidates[0]] }
  const output = await new AffinityEgress(state()).body("gemini", input)
  const emitted = parts([output])
  expect(emitted[0]?.thoughtSignature).toStartWith("vnext-affinity:2:")
  expect(emitted[1]?.thoughtSignature).toStartWith("vnext-affinity:1:")
  const analysis = await analyzeAffinityRequest("gemini", { contents: [{ role: "model", parts: [{ ...emitted[0], text: "answer plus SDK merged continuation" }] }] }, codec)
  expect(analysis.prepareSource()).toEqual({ contents: [{ role: "model", parts: [{ text: "answer plus SDK merged continuation" }] }] })
  expect(input.candidates?.[0]?.content.parts[0]).toEqual({ text: "answer" })
})

test("Gemini streaming keeps earlier text flowing and emits one origin at the logical boundary", async () => {
  const input = [event([{ text: "a" }]), event([{ text: "b" }]), event([{ text: "c" }], "STOP"), { usageMetadata: { candidatesTokenCount: 3 } }]
  const output = await stream(input)
  expect(parts(output).map(part => part.text)).toEqual(["a", "b", "c"])
  expect(parts(output).filter(part => typeof part.thoughtSignature === "string")).toHaveLength(1)
  expect(parts(output)[2]?.thoughtSignature).toStartWith("vnext-affinity:2:")
  expect(output.at(-1)).toEqual(input.at(-1))
})

test("Gemini immediate late natural signature is relocated onto real content with terminal metadata", async () => {
  const input = [event([{ text: "answer" }]), { ...event([{ thoughtSignature: "native" }], "STOP"), usageMetadata: { candidatesTokenCount: 1 }, responseId: "response", custom: "kept" }]
  const output = await stream(input)
  expect(output).toHaveLength(1)
  expect(parts(output)).toHaveLength(1)
  expect(parts(output)[0]).toMatchObject({ text: "answer" })
  expect(parts(output)[0]?.thoughtSignature).toStartWith("vnext-affinity:1:")
  expect(output[0]).toMatchObject({ usageMetadata: { candidatesTokenCount: 1 }, responseId: "response", custom: "kept", candidates: [{ finishReason: "STOP" }] })
  const analysis = await analyzeAffinityRequest("gemini", { contents: [{ role: "model", parts: parts(output) }] }, codec)
  expect(analysis.materialize(target)).toEqual({ contents: [{ role: "model", parts: [{ text: "answer", thoughtSignature: "native" }] }] })
})

test("Gemini signature-first and same-event trailers use real content instead of empty Parts", async () => {
  for (const input of [[event([{ thoughtSignature: "native" }]), event([{ text: "answer" }], "STOP")], [event([{ text: "answer" }, { thoughtSignature: "native" }], "STOP")]]) {
    const output = await stream(input)
    expect(parts(output)).toHaveLength(1)
    expect(parts(output)[0]).toMatchObject({ text: "answer" })
    expect(parts(output)[0]?.thoughtSignature).toStartWith("vnext-affinity:1:")
  }
})

test("Gemini preserves every real Part's natural signature and companion in JSON and streaming", async () => {
  const native: [Part, Part] = [{ text: "A", thoughtSignature: "native-a" }, { text: "B", thoughtSignature: "native-b" }]
  const json = await new AffinityEgress(state()).body("gemini", event(native, "STOP"))
  const together = await stream([event(native, "STOP")])
  const separate = await stream([event([native[0]]), event([native[1]], "STOP")])
  for (const emitted of [parts([json]), parts(together), parts(separate)]) {
    const analysis = await analyzeAffinityRequest("gemini", { contents: [{ role: "model", parts: emitted }] }, codec)
    expect(analysis.materialize(target)).toEqual({ contents: [{ role: "model", parts: native }] })
    expect(emitted.every(part => typeof part.thoughtSignature === "string" && part.thoughtSignature.startsWith("vnext-affinity:1:"))).toBe(true)
  }
})

test("Gemini never fabricates a Part for empty candidates or usage-only and error output", async () => {
  for (const input of [event([], "STOP"), event([{ text: "", thought: true }], "STOP"), { candidates: [] }, { usageMetadata: { candidatesTokenCount: 0 } }, { error: { message: "failed" } }]) {
    expect(await new AffinityEgress(state()).body("gemini", input)).toEqual(input)
    expect(await stream([input])).toEqual([input])
  }
})

test("Gemini output without a usable slot never loads or initializes a codec", async () => {
  let loads = 0
  const affinity = { protocol: "gemini" as const, actual: target, loadCodec: async () => { loads++; return codec } }
  const input = [event([], "STOP"), event([{ text: "", thought: true }], "STOP"), { usageMetadata: { candidatesTokenCount: 0 } }, { error: { message: "failed" } }]
  for (const body of input) expect(await new AffinityEgress(affinity).body("gemini", body)).toEqual(body)
  expect(await Array.fromAsync(new AffinityEgress(affinity).gemini(values(input)))).toEqual(input)
  expect(loads).toBe(0)
})

test("Gemini error and abrupt EOF leave unfinished visible content without a synthetic signature", async () => {
  const first = event([{ text: "partial" }])
  expect(await stream([first])).toEqual([first])
  const error = { error: { message: "failed" } }
  expect(await stream([first, error])).toEqual([first, error])
})

test("Gemini window reads only one event ahead and cancellation closes the upstream", async () => {
  let pulled = 0
  let closed = false
  async function* source() {
    try { for (let index = 0; index < 5; index++) { pulled++; yield event([{ text: String(index) }]) } }
    finally { closed = true }
  }
  const iterator = new AffinityEgress(state()).gemini(source())
  expect(await iterator.next()).toEqual({ value: event([{ text: "0" }]), done: false })
  expect(pulled).toBe(2)
  await iterator.return(undefined)
  expect(closed).toBe(true)
  expect(pulled).toBe(2)
})
