import { translatedFixture } from "../shared/translated-fixture"
import { expect, test } from "bun:test"
import { doneFrame, eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { llmEventResult } from "@vibe-llm/protocols/common"
import { translateChatToResponsesBody, translateChatToResponsesEvents } from "@vibe-llm/translate/responses-via-chat-completions"
import { prepareResponsesSource } from "../../../../src/data-plane/chat-flow/responses/source-result"

const identity = {
  incomingModel: "public", model: "public", modelKey: "upstream", upstream: "test", cost: null,
  translatorPair: { source: "responses" as const, hub: "chat_completions" as const },
}
const chatFrames: ProtocolFrame<unknown>[] = [
  eventFrame({ id: "chat_source", model: "upstream", created: 1, choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: "stop" }] }),
  eventFrame({ id: "chat_source", model: "upstream", choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
  doneFrame(),
]

function observeFrames(observed: ProtocolFrame<unknown>[]) {
  return async function* <T>(frames: AsyncIterable<ProtocolFrame<T>>): AsyncGenerator<ProtocolFrame<T>> {
    for await (const frame of frames) { observed.push(frame); yield frame }
  }
}

for (const wantsStream of [false, true]) {
  test(`${wantsStream ? "SSE event" : "JSON body"} translation stays lazy and observes only its original domain`, async () => {
    let pulls = 0
    let bodyTranslations = 0
    let eventTranslations = 0
    let acquired = 0
    const observed: ProtocolFrame<unknown>[] = []
    const rawFrames: AsyncIterable<ProtocolFrame<unknown>> = {
      [Symbol.asyncIterator]() {
        acquired++
        return (async function* () {
          for (const frame of chatFrames) { pulls++; yield frame }
        })()
      },
    }
    const result = translatedFixture({ kind: "translated", source: "responses", protocol: "chat_completions" }, rawFrames, identity, undefined, undefined,
      body => {
        bodyTranslations++
        return translateChatToResponsesBody(body, { sourcePayload: { instructions: "body-only field" } })
      },
      events => { eventTranslations++; return translateChatToResponsesEvents(events) },
    )
    const prepared = prepareResponsesSource({ result, rawFrames, wantsStream, upstreamAbortController: new AbortController(), observe: observeFrames(observed) })
    expect(prepared.protocol).toBe("responses")
    const iterator = prepared.frames[Symbol.asyncIterator]()
    expect(acquired).toBe(0)
    expect(pulls).toBe(0)
    expect(bodyTranslations).toBe(0)
    expect(eventTranslations).toBe(0)
    const output = await Array.fromAsync({ [Symbol.asyncIterator]: () => iterator })
    expect(pulls).toBe(3)
    const final = output.at(-1)
    expect(final?.type).toBe("event")
    if (final?.type !== "event" || final.event.type !== "response.completed") throw new Error("Expected a completed source response")
    expect(final.event.response).toMatchObject({ id: "chat_source", status: "completed" })
    if (wantsStream) {
      expect(bodyTranslations).toBe(0)
      expect(eventTranslations).toBe(1)
      expect(final.event.response.output[0]).toMatchObject({ type: "message", content: [{ type: "output_text", text: "hello", annotations: [] }] })
      expect(output.some(frame => frame.type === "event" && frame.event.type === "response.output_text.delta")).toBe(true)
      expect(observed).toEqual(output)
      expect(observed.every(frame => frame.type === "event" && typeof (frame.event as { type?: unknown }).type === "string")).toBe(true)
    } else {
      expect(bodyTranslations).toBe(1)
      expect(eventTranslations).toBe(0)
      expect(output).toHaveLength(1)
      expect(final.event.response).toMatchObject({ output_text: "hello", instructions: "body-only field", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } })
      expect(observed).toEqual(chatFrames)
    }
  })
}

test("an untranslated source preserves frames without pulling before consumption", async () => {
  const terminal = eventFrame({ type: "response.completed" as const, response: { id: "native", status: "completed", output: [] } })
  const raw = [terminal, doneFrame()]
  let pulls = 0
  async function* rawFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
    for (const frame of raw) { pulls++; yield frame }
  }
  const frames = rawFrames()
  const observed: ProtocolFrame<unknown>[] = []
  const prepared = prepareResponsesSource({ result: llmEventResult(frames, identity), rawFrames: frames, wantsStream: false, upstreamAbortController: new AbortController(), observe: observeFrames(observed) })
  expect(pulls).toBe(0)
  expect(await Array.fromAsync(prepared.frames)).toEqual(raw)
  expect(observed).toEqual(raw)
})

test("a late raw failure prevents a translator's pending success from reaching source observation", async () => {
  const upstream = new AbortController()
  const failure = new Error("late source failure")
  const observed: ProtocolFrame<unknown>[] = []
  async function* rawFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
    yield chatFrames[0] ?? doneFrame()
    throw failure
  }
  const raw = rawFrames()
  const result = translatedFixture({ kind: "translated", source: "responses", protocol: "chat_completions" }, raw, identity, undefined, undefined, undefined, async function* () {
    yield { type: "response.completed", response: { id: "pending", status: "completed", output: [] } }
  })
  const prepared = prepareResponsesSource({ result, rawFrames: raw, wantsStream: true, upstreamAbortController: upstream, observe: observeFrames(observed) })
  await expect(Array.fromAsync(prepared.frames)).rejects.toThrow("late source failure")
  expect(observed).toEqual([])
  expect(upstream.signal.aborted).toBe(true)
})

test("source cancellation interrupts a pending translated read while retaining the original reason", async () => {
  const upstream = new AbortController()
  const entered = Promise.withResolvers<void>()
  let translatorClosed = false
  const raw: AsyncIterable<ProtocolFrame<unknown>> = (async function* () { yield* chatFrames })()
  const result = translatedFixture({ kind: "translated", source: "responses", protocol: "chat_completions" }, raw, identity, undefined, undefined, undefined, async function* (_events, context) {
    try {
      yield { type: "response.created", response: { id: "cancelled" } }
      entered.resolve()
      await new Promise<void>(resolve => context.signal?.addEventListener("abort", () => resolve(), { once: true }))
    } finally { translatorClosed = true }
  })
  const prepared = prepareResponsesSource({ result, rawFrames: raw, wantsStream: true, upstreamAbortController: upstream, observe: observeFrames([]) })
  const iterator = prepared.frames[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  const pending = iterator.next()
  await entered.promise
  const reason = { cause: "source cancelled" }
  upstream.abort(reason)
  await expect(pending).rejects.toThrow("Response cancelled.")
  expect(upstream.signal.reason).toBe(reason)
  expect(translatorClosed).toBe(true)
})

test("return before source consumption leaves raw iterator cleanup with the turn", async () => {
  let returned = 0
  const raw: AsyncIterableIterator<ProtocolFrame<unknown>> = {
    [Symbol.asyncIterator]() { return this },
    next: async () => ({ done: true, value: undefined }),
    return: async () => { returned++; return { done: true, value: undefined } },
  }
  const prepared = prepareResponsesSource({ result: llmEventResult(raw, identity), rawFrames: raw, wantsStream: true, upstreamAbortController: new AbortController(), observe: observeFrames([]) })
  await prepared.frames[Symbol.asyncIterator]().return?.()
  expect(returned).toBe(0)
})
