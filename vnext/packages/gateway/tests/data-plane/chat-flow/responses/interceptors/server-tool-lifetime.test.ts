import { expect, test } from "bun:test"
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
