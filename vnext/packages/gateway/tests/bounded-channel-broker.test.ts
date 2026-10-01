import { expect, test } from "bun:test"
import { EventTargetChannelBroker } from "../src/shared/runtime/event-target-channel-broker.ts"

const codec = { encode: (value: string) => value, decode: (value: string) => value }
const policy = { maxFrames: 2, maxQueueBytes: 264, maxFrameBytes: 132 }

test("bounded count and bytes admit exact limits, overflow rejects once and detaches", async () => {
  for (const [limits, reason] of [
    [{ ...policy, maxQueueBytes: 1000 }, "queue_count"],
    [{ ...policy, maxFrames: 10 }, "queue_bytes"],
  ] as const) {
    let encodes = 0
    const broker = new EventTargetChannelBroker({ ...codec, encode(value: string) { encodes++; return value } })
    const handle = broker.subscribeBounded("k", new AbortController().signal, limits)
    const iterator = handle.iterable[Symbol.asyncIterator]()
    await broker.publish("k", "aa")
    await broker.publish("k", "bb")
    expect(handle.state).toEqual({ status: "active" })
    await broker.publish("k", "cc")
    expect(handle.state).toEqual({ status: "reconciliation_required", reason })
    await expect(iterator.next()).rejects.toMatchObject({ reason })
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    await broker.publish("k", "dd")
    expect(encodes).toBe(3)
  }
})

test("pending reader checks frame bytes and receives exactly one capacity rejection", async () => {
  const broker = new EventTargetChannelBroker(codec)
  const handle = broker.subscribeBounded("k", new AbortController().signal, policy)
  const iterator = handle.iterable[Symbol.asyncIterator]()
  const pending = iterator.next()
  const rejected = pending.catch((error: unknown) => error)
  await broker.publish("k", "aaa")
  expect(await rejected).toMatchObject({ reason: "frame_bytes" })
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
})

test("bounded decode is lazy, graceful close drains, cancellation discards", async () => {
  let decoded = 0
  const broker = new EventTargetChannelBroker({ ...codec, decode(value: string) { decoded++; return value } })
  const abort = new AbortController()
  const handle = broker.subscribeBounded("k", abort.signal, policy)
  const iterator = handle.iterable[Symbol.asyncIterator]()
  expect(iterator).toBe(handle.iterable[Symbol.asyncIterator]())
  await broker.publish("k", "aa")
  await broker.publish("k", "bb")
  expect(decoded).toBe(0)
  await broker.closeChannel("k", "closed")
  expect(await iterator.next()).toEqual({ done: false, value: "aa" })
  abort.abort()
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
  expect(decoded).toBe(1)
})

test("decode reentry gates cancellation, close drain, and overflow", async () => {
  for (const action of ["cancel", "close", "overflow"] as const) {
    const broker = new EventTargetChannelBroker({ ...codec, decode(value: string) {
      if (action === "cancel") handle.cancel()
      if (action === "close") void broker.closeChannel("k", "closed")
      if (action === "overflow") void broker.publish("k", "aaa")
      return value
    } })
    const handle = broker.subscribeBounded("k", new AbortController().signal, policy)
    const iterator = handle.iterable[Symbol.asyncIterator]()
    await broker.publish("k", "aa")
    if (action === "overflow") await expect(iterator.next()).rejects.toMatchObject({ reason: "frame_bytes" })
    else expect(await iterator.next()).toEqual(action === "close" ? { done: false, value: "aa" } : { done: true, value: undefined })
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  }
})

test("pending decode reentry rejects concurrent reads without displacing the reader", async () => {
  const broker = new EventTargetChannelBroker(codec)
  const handle = broker.subscribeBounded("k", new AbortController().signal, policy)
  const iterator = handle.iterable[Symbol.asyncIterator]()
  const pending = iterator.next()
  await expect(iterator.next()).rejects.toThrow("pending")
  await broker.publish("k", "aa")
  expect(await pending).toEqual({ done: false, value: "aa" })
  handle.cancel()
})

test("already aborted bounded subscription never registers or encodes", async () => {
  const abort = new AbortController()
  abort.abort()
  const broker = new EventTargetChannelBroker({ ...codec, encode() { throw new Error("unexpected encode") } })
  const handle = broker.subscribeBounded("k", abort.signal, policy)
  await broker.publish("k", "aa")
  expect(await handle.iterable[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
})

test("production defaults admit exactly 100 frames and 256 KiB before overflow", async () => {
  const limits = { maxFrames: 100, maxQueueBytes: 256 * 1024, maxFrameBytes: 16 * 1024 }
  for (const [frames, payload, reason] of [[100, "x", "queue_count"], [16, "x".repeat(8128), "queue_bytes"]] as const) {
    const broker = new EventTargetChannelBroker(codec)
    const handle = broker.subscribeBounded("k", new AbortController().signal, limits)
    for (let index = 0; index < frames; index++) await broker.publish("k", payload)
    expect(handle.state.status).toBe("active")
    await broker.publish("k", payload)
    expect(handle.state).toEqual({ status: "reconciliation_required", reason })
    await expect(handle.iterable[Symbol.asyncIterator]().next()).rejects.toMatchObject({ reason })
  }
})

test("bounded graceful closure drains all admitted FIFO frames and ends", async () => {
  const broker = new EventTargetChannelBroker(codec)
  const handle = broker.subscribeBounded("k", new AbortController().signal, policy)
  const iterator = handle.iterable[Symbol.asyncIterator]()
  await broker.publish("k", "aa")
  await broker.publish("k", "bb")
  await broker.closeChannel("k", "done")
  expect(await iterator.next()).toEqual({ done: false, value: "aa" })
  expect(await iterator.next()).toEqual({ done: false, value: "bb" })
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
})

test("bounded return settles pending read; throwing cancels residual frames", async () => {
  const broker = new EventTargetChannelBroker(codec)
  const handle = broker.subscribeBounded("k", new AbortController().signal, policy)
  const iterator = handle.iterable[Symbol.asyncIterator]()
  const pending = iterator.next()
  await iterator.return?.()
  expect(await pending).toEqual({ done: true, value: undefined })
  const other = broker.subscribeBounded("k", new AbortController().signal, policy).iterable[Symbol.asyncIterator]()
  await broker.publish("k", "aa")
  const failure = new Error("stop")
  if (!other.throw) throw new Error("expected iterator throw")
  await expect(other.throw(failure)).rejects.toBe(failure)
  expect(await other.next()).toEqual({ done: true, value: undefined })
})
