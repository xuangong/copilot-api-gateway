// Tests for EventTargetChannelBroker — in-process fan-out backed by
// EventTarget. Verifies eager-registration invariant (publish after
// subscribe but before drain still delivers), close terminates iterators,
// and AbortSignal cancels the iteration.

import { test, expect, spyOn } from "bun:test"
import { EventTargetChannelBroker } from "../src/shared/runtime/event-target-channel-broker.ts"
import { dumpCodec } from "../src/shared/dump/codec.ts"
import type { DumpMetadata } from "../src/shared/dump/types.ts"

const makeMeta = (id: string): DumpMetadata => ({
  id,
  startedAt: 0,
  completedAt: 100,
  method: "POST",
  path: "/v1/chat/completions",
  status: 200,
  upstream: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 100,
  error: null,
})

test("publish → subscribe fan-out delivers decoded frame", async () => {
  const broker = new EventTargetChannelBroker<DumpMetadata>(dumpCodec)
  const ac = new AbortController()
  const iter = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()

  await broker.publish("k1", makeMeta("rec-1"))
  const { value, done } = await iter.next()
  expect(done).toBe(false)
  expect(value.id).toBe("rec-1")
  ac.abort()
})

test("subscribe eagerly registers so publish before drain still delivers", async () => {
  const broker = new EventTargetChannelBroker<DumpMetadata>(dumpCodec)
  const ac = new AbortController()
  // Get the iterable but don't call .next() yet.
  const iterable = broker.subscribe("k1", ac.signal)
  // Publish before draining.
  await broker.publish("k1", makeMeta("rec-early"))
  const iter = iterable[Symbol.asyncIterator]()
  const { value, done } = await iter.next()
  expect(done).toBe(false)
  expect(value.id).toBe("rec-early")
  ac.abort()
})

test("multiple publishes are queued in order", async () => {
  const broker = new EventTargetChannelBroker<DumpMetadata>(dumpCodec)
  const ac = new AbortController()
  const iter = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  await broker.publish("k1", makeMeta("rec-1"))
  await broker.publish("k1", makeMeta("rec-2"))
  await broker.publish("k1", makeMeta("rec-3"))
  const a = await iter.next()
  const b = await iter.next()
  const c = await iter.next()
  expect(a.value.id).toBe("rec-1")
  expect(b.value.id).toBe("rec-2")
  expect(c.value.id).toBe("rec-3")
  ac.abort()
})

test("closeChannel ends the iterator with done=true", async () => {
  const broker = new EventTargetChannelBroker<DumpMetadata>(dumpCodec)
  const ac = new AbortController()
  const iter = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  const nextP = iter.next()
  await broker.closeChannel("k1", "test")
  const r = await nextP
  expect(r.done).toBe(true)
})

test("AbortSignal ends the iterator with done=true", async () => {
  const broker = new EventTargetChannelBroker<DumpMetadata>(dumpCodec)
  const ac = new AbortController()
  const iter = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  const nextP = iter.next()
  ac.abort()
  const r = await nextP
  expect(r.done).toBe(true)
})

test("channels are isolated: publish on 'a' does not surface on 'b'", async () => {
  const broker = new EventTargetChannelBroker<DumpMetadata>(dumpCodec)
  const acA = new AbortController()
  const acB = new AbortController()
  const iterA = broker.subscribe("a", acA.signal)[Symbol.asyncIterator]()
  const iterB = broker.subscribe("b", acB.signal)[Symbol.asyncIterator]()

  await broker.publish("a", makeMeta("only-a"))
  const a = await iterA.next()
  expect(a.value.id).toBe("only-a")

  // Abort B — its next() should resolve with done=true, proving no frame
  // was ever queued for it.
  const bP = iterB.next()
  acB.abort()
  const b = await bP
  expect(b.done).toBe(true)
  acA.abort()
})

const stringCodec = { encode: (value: string) => value, decode: (value: string) => value }

async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("iterator did not settle")), 100)
    })])
  } finally {
    clearTimeout(timeout)
  }
}

function returnFrom<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
  if (!iterator.return) throw new Error("expected a cancellable iterator")
  return iterator.return()
}

function throwInto<T>(iterator: AsyncIterator<T>, error: Error): Promise<IteratorResult<T>> {
  if (!iterator.throw) throw new Error("expected an iterator throw method")
  return iterator.throw(error)
}

test("publish without subscribers skips a throwing codec", async () => {
  let encoded = 0
  const broker = new EventTargetChannelBroker<string>({
    encode() {
      encoded++
      throw new Error("notification encoding must be skipped")
    },
    decode: stringCodec.decode,
  })
  await expect(broker.publish("unused", "frame")).resolves.toBeUndefined()
  expect(encoded).toBe(0)
  await broker.closeChannel("unused", "test")
  await expect(broker.closeChannel("unused", "again")).resolves.toBeUndefined()
})

test("an already-aborted subscription stays done without listeners or encoding", async () => {
  let encoded = 0
  const broker = new EventTargetChannelBroker<string>({
    encode(value) {
      encoded++
      return value
    },
    decode: stringCodec.decode,
  })
  const ac = new AbortController()
  ac.abort()
  const add = spyOn(ac.signal, "addEventListener")
  const iterable = broker.subscribe("k1", ac.signal)
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    expect(await within(iterator.next())).toEqual({ value: undefined, done: true })
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
    await broker.publish("k1", "ignored")
    expect(encoded).toBe(0)
    expect(add.mock.calls).toEqual([])
  } finally {
    add.mockRestore()
    await returnFrom(iterator)
  }
})

test("abort discards buffered frames and releases the last subscription", async () => {
  let encoded = 0
  const broker = new EventTargetChannelBroker<string>({
    encode(value) {
      encoded++
      return value
    },
    decode: stringCodec.decode,
  })
  const ac = new AbortController()
  const iterator = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  await broker.publish("k1", "buffered")
  ac.abort()
  ac.abort()
  expect(await iterator.next()).toEqual({ value: undefined, done: true })
  await broker.publish("k1", "ignored")
  expect(encoded).toBe(1)
})

test("return before first pull discards frames and repeated cancellation is inert", async () => {
  let encoded = 0
  const broker = new EventTargetChannelBroker<string>({
    encode(value) {
      encoded++
      return value
    },
    decode: stringCodec.decode,
  })
  const ac = new AbortController()
  const remove = spyOn(ac.signal, "removeEventListener")
  const iterator = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  try {
    await broker.publish("k1", "buffered")
    expect(await returnFrom(iterator)).toEqual({ value: undefined, done: true })
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
    await returnFrom(iterator)
    ac.abort()
    await broker.publish("k1", "ignored")
    expect(encoded).toBe(1)
    expect(remove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1)
  } finally {
    remove.mockRestore()
    ac.abort()
  }
})

test("return resolves an existing pending next with done", async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec)
  const ac = new AbortController()
  const iterator = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  const pending = iterator.next()
  try {
    await returnFrom(iterator)
    expect(await within(pending)).toEqual({ value: undefined, done: true })
  } finally {
    ac.abort()
  }
})

test("throw cancels buffered consumption and rejects with the supplied error", async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec)
  const ac = new AbortController()
  const iterator = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  await broker.publish("k1", "buffered")
  const failure = new Error("consumer stopped")
  try {
    await expect(throwInto(iterator, failure)).rejects.toBe(failure)
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
  } finally {
    ac.abort()
  }
})

test("throw resolves the pending read before rejecting", async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec)
  const ac = new AbortController()
  const iterator = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  const pending = iterator.next()
  const failure = new Error("consumer stopped")
  try {
    await expect(throwInto(iterator, failure)).rejects.toBe(failure)
    expect(await within(pending)).toEqual({ value: undefined, done: true })
  } finally {
    ac.abort()
  }
})

test("iterator retrieval returns the same subscription consumer", async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec)
  const ac = new AbortController()
  const iterable = broker.subscribe("k1", ac.signal)
  try {
    expect(iterable[Symbol.asyncIterator]()).toBe(iterable[Symbol.asyncIterator]())
  } finally {
    ac.abort()
  }
})

test("a second pending next rejects without displacing the first reader", async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec)
  const ac = new AbortController()
  const iterable = broker.subscribe("k1", ac.signal)
  const iterator = iterable[Symbol.asyncIterator]()
  const other = iterable[Symbol.asyncIterator]()
  const first = iterator.next()
  try {
    await expect(within(other.next())).rejects.toThrow("pending")
    await broker.publish("k1", "first reader")
    expect(await within(first)).toEqual({ value: "first reader", done: false })
  } finally {
    ac.abort()
  }
})

test("ending one subscriber keeps fanout live until the last subscriber ends", async () => {
  let encoded = 0
  const broker = new EventTargetChannelBroker<string>({
    encode(value) {
      encoded++
      return value
    },
    decode: stringCodec.decode,
  })
  const a = new AbortController(), b = new AbortController()
  const first = broker.subscribe("k1", a.signal)[Symbol.asyncIterator]()
  const second = broker.subscribe("k1", b.signal)[Symbol.asyncIterator]()
  await broker.publish("k1", "both")
  expect(await first.next()).toEqual({ value: "both", done: false })
  expect(await second.next()).toEqual({ value: "both", done: false })
  a.abort()
  await broker.publish("k1", "remaining")
  expect(await second.next()).toEqual({ value: "remaining", done: false })
  await returnFrom(second)
  await broker.publish("k1", "ignored")
  expect(encoded).toBe(2)
  expect(await first.next()).toEqual({ value: undefined, done: true })
  b.abort()
})

test("graceful close drains FIFO and retains abort observation only until drained", async () => {
  let encoded = 0
  const broker = new EventTargetChannelBroker<string>({
    encode(value) {
      encoded++
      return value
    },
    decode: stringCodec.decode,
  })
  const ac = new AbortController()
  const add = spyOn(ac.signal, "addEventListener")
  const remove = spyOn(ac.signal, "removeEventListener")
  const iterator = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  try {
    await broker.publish("k1", "first")
    await broker.publish("k1", "second")
    await broker.closeChannel("k1", "test")
    await broker.publish("k1", "ignored")
    expect(encoded).toBe(2)
    expect(add.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1)
    expect(remove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(0)
    expect(await iterator.next()).toEqual({ value: "first", done: false })
    expect(remove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(0)
    expect(await iterator.next()).toEqual({ value: "second", done: false })
    expect(remove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1)
    expect(remove.mock.calls.find(([type]) => type === "abort")?.[1])
      .toBe(add.mock.calls.find(([type]) => type === "abort")?.[1])
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
    expect(remove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1)
  } finally {
    add.mockRestore()
    remove.mockRestore()
    ac.abort()
  }
})

test("abort after graceful close drops the residual buffer before another pull", async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec)
  const ac = new AbortController()
  const remove = spyOn(ac.signal, "removeEventListener")
  const iterator = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  try {
    await broker.publish("k1", "buffered")
    await broker.closeChannel("k1", "test")
    expect(remove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(0)
    ac.abort()
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
    expect(remove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1)
  } finally {
    remove.mockRestore()
    ac.abort()
  }
})

test("return after graceful close drops the residual buffer", async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec)
  const ac = new AbortController()
  const iterator = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  await broker.publish("k1", "buffered")
  await broker.closeChannel("k1", "test")
  await returnFrom(iterator)
  expect(await iterator.next()).toEqual({ value: undefined, done: true })
  ac.abort()
})

test("graceful close without a residual buffer detaches abort observation immediately", async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec)
  const ac = new AbortController()
  const remove = spyOn(ac.signal, "removeEventListener")
  const iterator = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  const pending = iterator.next()
  try {
    await broker.closeChannel("k1", "test")
    expect(await within(pending)).toEqual({ value: undefined, done: true })
    expect(remove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1)
  } finally {
    remove.mockRestore()
    ac.abort()
  }
})

test("old buffered cleanup cannot release a recreated channel", async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec)
  const oldSignal = new AbortController(), freshSignal = new AbortController()
  const old = broker.subscribe("k1", oldSignal.signal)[Symbol.asyncIterator]()
  await broker.publish("k1", "old")
  await broker.closeChannel("k1", "test")
  const fresh = broker.subscribe("k1", freshSignal.signal)[Symbol.asyncIterator]()
  await returnFrom(old)
  oldSignal.abort()
  await broker.publish("k1", "fresh")
  expect(await within(fresh.next())).toEqual({ value: "fresh", done: false })
  freshSignal.abort()
})

test("close removes the old entry before reentrant subscription during cleanup", async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec)
  const oldSignal = new AbortController(), freshSignal = new AbortController()
  const old = broker.subscribe("k1", oldSignal.signal)[Symbol.asyncIterator]()
  let fresh: AsyncIterator<string> | undefined
  const remove = oldSignal.signal.removeEventListener.bind(oldSignal.signal)
  const cleanup = spyOn(oldSignal.signal, "removeEventListener").mockImplementation((type, listener, options) => {
    remove(type, listener, options)
    if (type === "abort") fresh = broker.subscribe("k1", freshSignal.signal)[Symbol.asyncIterator]()
  })
  try {
    await broker.closeChannel("k1", "test")
    if (!fresh) throw new Error("cleanup did not recreate the channel")
    await broker.publish("k1", "fresh")
    expect(await within(fresh.next())).toEqual({ value: "fresh", done: false })
    expect(await old.next()).toEqual({ value: undefined, done: true })
  } finally {
    cleanup.mockRestore()
    oldSignal.abort()
    freshSignal.abort()
  }
})

test("cancellation during decode cannot enqueue a frame after termination", async () => {
  const ac = new AbortController()
  const broker = new EventTargetChannelBroker<string>({
    encode: stringCodec.encode,
    decode(value) {
      ac.abort()
      return value
    },
  })
  const iterator = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  await broker.publish("k1", "canceled during decode")
  expect(await iterator.next()).toEqual({ value: undefined, done: true })
})
