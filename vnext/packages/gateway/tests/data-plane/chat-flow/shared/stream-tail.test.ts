import { expect, test } from "bun:test"
import { StreamTail, StreamTailError, STREAM_TAIL_TIMEOUT_MS } from "../../../../src/data-plane/chat-flow/shared/stream-tail"

test("an expired terminal deadline rejects before another source pull", async () => {
  const tail = new StreamTail()
  tail.start()
  await Bun.sleep(STREAM_TAIL_TIMEOUT_MS + 10)
  let pulled = false
  const iterator = { next: async () => { pulled = true; return { done: false as const, value: "late" } } }
  await expect(tail.next(iterator)).rejects.toBeInstanceOf(StreamTailError)
  expect(pulled).toBe(false)
})

test("abort interrupts the pending pull and consumes a late source rejection", async () => {
  const tail = new StreamTail()
  const abort = new AbortController()
  const source = Promise.withResolvers<IteratorResult<string>>()
  const pending = tail.next({ next: () => source.promise }, abort.signal)
  abort.abort()
  await expect(pending).rejects.toThrow("Response cancelled.")
  source.reject(new Error("late upstream rejection"))
  await Promise.resolve()
  await expect(tail.next({ next: async () => ({ done: true as const, value: undefined }) }, abort.signal)).rejects.toThrow("Response cancelled.")
})

test("disposal settles a pending pull and ignores its later value", async () => {
  const tail = new StreamTail()
  const source = Promise.withResolvers<IteratorResult<string>>()
  const pending = tail.next({ next: () => source.promise })
  tail.dispose()
  await expect(pending).rejects.toThrow("Response cancelled.")
  source.resolve({ done: false, value: "late" })
  await expect(tail.next({ next: () => source.promise })).rejects.toThrow("Response cancelled.")
})

test("a new signal replaces the previous consumer signal after a completed read", async () => {
  const tail = new StreamTail()
  const old = new AbortController()
  const current = new AbortController()
  expect(await tail.next({ next: async () => ({ done: false as const, value: "first" }) }, old.signal)).toEqual({ done: false, value: "first" })
  const source = Promise.withResolvers<IteratorResult<string>>()
  const pending = tail.next({ next: () => source.promise }, current.signal)
  old.abort()
  source.resolve({ done: false, value: "second" })
  expect(await pending).toEqual({ done: false, value: "second" })
  const cancelled = tail.next({ next: () => new Promise<IteratorResult<string>>(() => {}) }, current.signal)
  current.abort()
  await expect(cancelled).rejects.toThrow("Response cancelled.")
  tail.dispose()
})

test("source failure clears the pending read and terminal observation survives iterator handoff", async () => {
  const tail = new StreamTail()
  await expect(tail.next({ next: () => { throw new Error("synchronous source failure") } })).rejects.toThrow("synchronous source failure")
  tail.start()
  expect(await tail.next({ next: async () => ({ done: true as const, value: undefined }) })).toEqual({ done: true, value: undefined })
  expect(await tail.next({ next: async () => ({ done: false as const, value: "trailing usage" }) })).toEqual({ done: false, value: "trailing usage" })
  tail.dispose()
})
