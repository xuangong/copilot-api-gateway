// Tests for EventTargetChannelBroker — in-process fan-out backed by
// EventTarget. Verifies eager-registration invariant (publish after
// subscribe but before drain still delivers), close terminates iterators,
// and AbortSignal cancels the iteration.

import { test, expect } from "bun:test"
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

test("closeChannel is a no-op on unknown channel", async () => {
  const broker = new EventTargetChannelBroker<DumpMetadata>(dumpCodec)
  await broker.closeChannel("never-subscribed", "test")
  // Reaching this line without throwing is the assertion.
  expect(true).toBe(true)
})

test("iterator.return() cleans up without further next() resolutions", async () => {
  const broker = new EventTargetChannelBroker<DumpMetadata>(dumpCodec)
  const ac = new AbortController()
  const iter = broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()
  const r = await iter.return!()
  expect(r.done).toBe(true)
  ac.abort()
})
