import { expect, test } from "bun:test"
import { eventFrame } from "@vibe-core/result"
import type { ResponsesResult, ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import type { ApiKeyId } from "../../../../../src/repo/branded-ids"
import { createWebSearchExecutionScope } from "../../../../../src/data-plane/tools/web-search/execution-scope"
import { ServerToolLifetime } from "../../../../../src/data-plane/chat-flow/responses/interceptors/server-tool-lifetime"

test("a close callback can reenter closure without repeating settlement or state disposal", async () => {
  let disposed = 0
  let callbacks = 0
  let returned = 0
  let reentrant: Promise<void> | undefined
  const lifetime = new ServerToolLifetime(() => { disposed++; return undefined })
  lifetime.trackIterator({
    next: async () => ({ done: true, value: undefined }),
    return: async () => { returned++; return { done: true, value: undefined } },
  })
  lifetime.onClose(() => {
    callbacks++
    expect(lifetime.isClosed).toBe(true)
    if (callbacks === 1) reentrant = lifetime.close()
  })
  const closing = lifetime.close()
  await Promise.all([closing, reentrant])
  expect(reentrant).toBe(closing)
  expect(disposed).toBe(1)
  expect(callbacks).toBe(1)
  expect(returned).toBe(1)
})

test("callbacks registered after close run directly and do not participate in another closure", async () => {
  let calls = 0
  const lifetime = new ServerToolLifetime(() => undefined)
  const closing = lifetime.close()
  await closing
  lifetime.onClose(() => {
    calls++
    expect(lifetime.close()).toBe(closing)
  })
  expect(calls).toBe(1)
  await lifetime.close()
  expect(calls).toBe(1)
  const error = new Error("late callback failure")
  expect(() => lifetime.onClose(() => { throw error })).toThrow(error)
  await lifetime.close()
})

test("a throwing close callback still closes resources and preserves cleanup failure", async () => {
  let callbacks = 0
  let returned = 0
  const lifetime = new ServerToolLifetime(() => undefined)
  lifetime.trackIterator({
    next: async () => ({ done: true, value: undefined }),
    return: async () => { returned++; return { done: true, value: undefined } },
  })
  lifetime.onClose(() => { callbacks++; throw new Error("callback failure") })
  const closing = lifetime.close()
  await expect(closing).rejects.toThrow("cleanup incomplete")
  expect(lifetime.close()).toBe(closing)
  await expect(lifetime.close()).rejects.toThrow("cleanup incomplete")
  expect(callbacks).toBe(1)
  expect(returned).toBe(1)
})

for (const mode of ["discard", "abort", "open"] as const) test(`same-tick Responses ${mode} between read settlement and final delivery preserves owner gates`, async () => {
  const controller = new AbortController()
  const search = createWebSearchExecutionScope({ getProvider: async () => ({ type: "disabled" }), filters: {}, apiKeyId: "key_test" as ApiKeyId, includeSearchActionSources: false, signal: controller.signal })
  let stateOpen = true
  let disposals = 0
  let callbacks = 0
  let returns = 0
  const metadata = Promise.withResolvers<{ closed: true }>()
  const owner = new ServerToolLifetime(() => { stateOpen = false; disposals++; return undefined }, controller.signal)
  owner.ownWork(search)
  owner.onClose(() => { callbacks++; metadata.resolve({ closed: true }) })
  const response = { id: "response", object: "response", model: "m", output: [], status: "completed", error: null, incomplete_details: null } as ResponsesResult
  const terminal = eventFrame<ResponsesStreamEvent>({ type: "response.completed", response })
  const generator = (async function* () { yield terminal })()
  const next = generator.next.bind(generator)
  const returnGenerator = generator.return.bind(generator)
  let closing: Promise<void> | undefined
  generator.next = (...args) => {
    const step = next(...args)
    // Queue close after wait resolves but before the outer next continuation.
    void step.then(() => queueMicrotask(() => {
      if (mode === "open") return
      if (mode === "abort") controller.abort()
      closing = owner.close()
    }))
    return step
  }
  generator.return = (...args) => { returns++; return returnGenerator(...args) }
  const iterator = owner.wrap(generator)
  const reading = iterator.next()
  if (mode === "open") {
    expect(await reading).toEqual({ done: false, value: terminal })
    expect(stateOpen).toBe(true)
    expect(owner.isClosed).toBe(false)
    expect((await iterator.next()).done).toBe(true)
  } else {
    await expect(reading).rejects.toThrow("Server-tool invocation is closed")
    await closing
  }
  await owner.close()
  await search.settled()
  expect(owner.isClosed).toBe(true)
  expect(stateOpen).toBe(false)
  expect(() => search.assertOpen()).toThrow()
  expect(controller.signal.aborted).toBe(mode === "abort")
  expect(disposals).toBe(1)
  expect(callbacks).toBe(1)
  expect(await metadata.promise).toEqual({ closed: true })
  expect(returns).toBe(mode === "open" ? 0 : 1)
})
