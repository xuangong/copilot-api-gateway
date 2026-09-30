import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { initBackground } from "@vibe-core/platform"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { llmEventResult } from "@vibe-llm/protocols/common"
import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { setupTestPlatform } from "../../../_setup-platform"
import { startResponsesTurn } from "../../../../src/data-plane/chat-flow/responses/serve"
import { createResponsesTurn, type PreparedResponsesTurn } from "../../../../src/data-plane/chat-flow/responses/turn"

let db: Database
let background: Promise<unknown>[]
beforeEach(() => {
  db = setupTestPlatform().db
  background = []
  initBackground({ waitUntil: promise => { background.push(promise) } })
})
afterEach(async () => {
  await Promise.allSettled(background)
  db.close()
})

const identity = { incomingModel: "model", model: "model", modelKey: "model", upstream: "test", cost: null }
const response = { id: "resp_abort_guard", object: "response", status: "completed", model: "model", output: [] }
async function* frames(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  yield eventFrame({ type: "response.completed", response } as ResponsesStreamEvent)
}

function traceAbortListeners(signal: AbortSignal) {
  const added: EventListenerOrEventListenerObject[] = []
  const removed: EventListenerOrEventListenerObject[] = []
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  const addDescriptor = Object.getOwnPropertyDescriptor(signal, "addEventListener")
  const removeDescriptor = Object.getOwnPropertyDescriptor(signal, "removeEventListener")
  Object.defineProperty(signal, "addEventListener", {
    configurable: true,
    value(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      if (type === "abort" && listener) added.push(listener)
      if (listener) add(type, listener, options)
    },
  })
  Object.defineProperty(signal, "removeEventListener", {
    configurable: true,
    value(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
      if (type === "abort" && listener) removed.push(listener)
      if (listener) remove(type, listener, options)
    },
  })
  return {
    added,
    removed,
    restore() {
      if (addDescriptor) Object.defineProperty(signal, "addEventListener", addDescriptor)
      else Reflect.deleteProperty(signal, "addEventListener")
      if (removeDescriptor) Object.defineProperty(signal, "removeEventListener", removeDescriptor)
      else Reflect.deleteProperty(signal, "removeEventListener")
    },
  }
}

function blockedDump() {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const dump = {
    requestedModel(_model: string) {},
    finalize(value: Response) { return value },
    cancelled() {},
    failed(_reason: unknown) {},
    async finalizeTurn() { entered.resolve(); await release.promise },
  }
  return { dump, entered: entered.promise, release: () => release.resolve() }
}

for (const cancelDuringStorage of [false, true]) {
  test(`inbound abort link ${cancelDuringStorage ? "forwards the original reason during" : "is removed after"} owned dump cleanup`, async () => {
    const inbound = new AbortController()
    const trace = traceAbortListeners(inbound.signal)
    const blocked = blockedDump()
    // A parse error exercises the real start/preparation/turn boundary without
    // a provider. Only the final dump sink is held at an explicit barrier.
    const turn = startResponsesTurn({
      raw: null,
      auth: {},
      obsCtx: { apiKeyId: undefined, userAgent: undefined, requestId: undefined },
      signal: inbound.signal,
      dump: blocked.dump,
    })
    const events = Array.fromAsync(turn.events)
    try {
      expect((await turn.ready).status).toBe(400)
      await blocked.entered
      expect(trace.added).toHaveLength(1)
      expect(trace.removed).toHaveLength(0)
      expect(turn.abortController.signal.aborted).toBe(false)
      const reason = { cause: "inbound disconnect" }
      if (cancelDuringStorage) {
        inbound.abort(reason)
        expect(turn.abortController.signal.reason).toBe(reason)
      }
      blocked.release()
      expect(await turn.completion).toMatchObject({
        outcome: cancelDuringStorage ? "cancelled" : "failed",
        cleanupComplete: true,
      })
      expect(trace.removed).toEqual(trace.added)
      inbound.abort(reason)
      expect(turn.abortController.signal.aborted).toBe(cancelDuringStorage)
    } finally {
      blocked.release()
      await events
      await turn.completion
      trace.restore()
    }
  })
}

test("an already aborted inbound signal preserves its reason before preparation", async () => {
  const inbound = new AbortController()
  const reason = { cause: "already disconnected" }
  inbound.abort(reason)
  const turn = startResponsesTurn({
    raw: null,
    auth: {},
    obsCtx: { apiKeyId: undefined, userAgent: undefined, requestId: undefined },
    signal: inbound.signal,
  })
  expect((await turn.ready).status).toBe(499)
  expect(turn.abortController.signal.reason).toBe(reason)
  expect(await turn.completion).toEqual({ outcome: "cancelled", cleanupComplete: true })
})

test("abort in the construction stack prevents the scheduled preparation factory", async () => {
  const controller = new AbortController()
  let calls = 0
  const turn = createResponsesTurn(async () => {
    calls++
    return { result: llmEventResult(frames(), identity), options: { wantsStream: true } }
  }, { wantsStream: true, downstreamAbortController: controller })
  controller.abort("before preparation microtask")
  expect((await turn.ready).status).toBe(499)
  expect(await turn.completion).toEqual({ outcome: "cancelled", cleanupComplete: true })
  expect(calls).toBe(0)
})

test("a preparation factory starts once and publishes ready and reusable completion", async () => {
  let calls = 0
  const turn = createResponsesTurn(async () => {
    calls++
    return { result: llmEventResult(frames(), identity), options: { wantsStream: true } }
  }, { wantsStream: true })
  expect((await turn.ready).status).toBe(200)
  expect((await Array.fromAsync(turn.events)).map(event => event.type)).toEqual(["response.completed"])
  expect(await turn.completion).toEqual({ outcome: "completed", response, cleanupComplete: true })
  expect(calls).toBe(1)
})

for (const asynchronous of [false, true]) {
  test(`a ${asynchronous ? "rejected" : "throwing"} preparation factory settles one failure without retry`, async () => {
    let calls = 0
    const failure = new Error("fixture preparation failure")
    const turn = createResponsesTurn(() => {
      calls++
      if (asynchronous) return Promise.reject(failure)
      throw failure
    }, { wantsStream: true })
    expect(await turn.ready).toMatchObject({
      status: 502,
      body: { error: { type: "api_error", message: "fixture preparation failure" } },
    })
    expect((await Array.fromAsync(turn.events)).map(event => event.type)).toEqual(["error"])
    expect(await turn.completion).toEqual({ outcome: "failed", cleanupComplete: true })
    expect(calls).toBe(1)
  })
}

test("cancellation during preparation closes its eventual iterator once", async () => {
  const entered = Promise.withResolvers<void>()
  const prepared = Promise.withResolvers<PreparedResponsesTurn>()
  let calls = 0
  let returned = 0
  const source: AsyncIterableIterator<ProtocolFrame<ResponsesStreamEvent>> = {
    [Symbol.asyncIterator]() { return this },
    next: async () => ({ done: true, value: undefined }),
    return: async () => { returned++; return { done: true, value: undefined } },
  }
  const turn = createResponsesTurn(() => {
    calls++
    entered.resolve()
    return prepared.promise
  }, { wantsStream: true })
  try {
    await entered.promise
    turn.abortController.abort("cancel during preparation")
  } finally {
    prepared.resolve({ result: llmEventResult(source, identity), options: { wantsStream: true } })
  }
  expect(await turn.completion).toEqual({ outcome: "cancelled", cleanupComplete: true })
  expect(calls).toBe(1)
  expect(returned).toBe(1)
})
