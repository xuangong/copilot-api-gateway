import type { ChannelBroker, Codec } from "./channel-broker-contract.ts"

interface ChannelEntry {
  readonly target: EventTarget
  subscriptions: number
}

// In-process per-channel fan-out backed by EventTarget. The Bun deployment
// target only ever runs one worker process per gateway instance, so a Map of
// plain emitters is enough — no IPC, no cross-process broadcast.
export class EventTargetChannelBroker<T> implements ChannelBroker<T> {
  private readonly channels = new Map<string, ChannelEntry>()

  constructor(private readonly codec: Codec<T>) {}

  private acquire(channelId: string): ChannelEntry {
    let entry = this.channels.get(channelId)
    if (!entry) {
      entry = { target: new EventTarget(), subscriptions: 0 }
      this.channels.set(channelId, entry)
    }
    entry.subscriptions++
    return entry
  }

  private release(channelId: string, entry: ChannelEntry): void {
    entry.subscriptions--
    if (entry.subscriptions === 0 && this.channels.get(channelId) === entry) {
      this.channels.delete(channelId)
    }
  }

  async publish(channelId: string, payload: T): Promise<void> {
    const entry = this.channels.get(channelId)
    if (!entry) return
    entry.target.dispatchEvent(new CustomEvent("frame", { detail: this.codec.encode(payload) }))
  }

  async closeChannel(channelId: string, _reason: string): Promise<void> {
    const entry = this.channels.get(channelId)
    if (!entry) return
    // Close listeners may create a new subscription for this ID during cleanup.
    this.channels.delete(channelId)
    entry.target.dispatchEvent(new Event("close"))
  }

  subscribe(channelId: string, signal: AbortSignal): AsyncIterable<T> {
    const entry = signal.aborted ? undefined : this.acquire(channelId)
    return iterateFromTarget(entry?.target, signal, this.codec, () => {
      if (entry) this.release(channelId, entry)
    })
  }
}

// Register eagerly so publication before the first pull is buffered. One
// iterator owns the subscription, its queue, and at most one pending read.
const iterateFromTarget = <T>(
  target: EventTarget | undefined,
  signal: AbortSignal,
  codec: Codec<T>,
  release: () => void,
): AsyncIterable<T> => {
  const queue: IteratorYieldResult<T>[] = []
  let resolveNext: ((value: IteratorResult<T>) => void) | null = null
  let closed = target === undefined
  let released = target === undefined
  let abortAttached = false

  const done = (): IteratorResult<T> => ({ value: undefined, done: true })

  const detachAbort = (): void => {
    if (!abortAttached) return
    abortAttached = false
    signal.removeEventListener("abort", onAbort)
  }

  const terminate = (cancel: boolean): void => {
    if (!released) {
      released = true
      closed = true
      target?.removeEventListener("frame", onFrame)
      target?.removeEventListener("close", onClose)
      release()
    }
    if (cancel) queue.length = 0
    // After graceful close, abort must still be able to discard residual frames.
    if (cancel || queue.length === 0) detachAbort()
    const pending = resolveNext
    resolveNext = null
    pending?.(done())
  }

  const onFrame = (event: Event): void => {
    if (closed) return
    const payload = (event as CustomEvent<string>).detail
    const frame: IteratorYieldResult<T> = { value: codec.decode(payload), done: false }
    // The codec may synchronously terminate this subscription during decoding.
    if (closed) return
    if (resolveNext) {
      const pending = resolveNext
      resolveNext = null
      pending(frame)
    } else {
      queue.push(frame)
    }
  }
  const onClose = (): void => { terminate(false) }
  const onAbort = (): void => { terminate(true) }

  if (target) {
    target.addEventListener("frame", onFrame)
    target.addEventListener("close", onClose)
    abortAttached = true
    signal.addEventListener("abort", onAbort, { once: true })
    // Also handle an abort observed during eager registration.
    if (signal.aborted) terminate(true)
  }

  const iterator: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]: () => iterator,
    async next(): Promise<IteratorResult<T>> {
      if (resolveNext) throw new Error("A subscription already has a pending next()")
      const frame = queue.shift()
      if (frame) {
        if (closed && queue.length === 0) detachAbort()
        return frame
      }
      if (closed) return done()
      return await new Promise<IteratorResult<T>>(resolve => { resolveNext = resolve })
    },
    async return(): Promise<IteratorResult<T>> {
      terminate(true)
      return done()
    },
    async throw(error?: unknown): Promise<IteratorResult<T>> {
      terminate(true)
      throw error
    },
  }
  return iterator
}
