import {
  ChannelCapacityError, encodedFrameCharge,
  type BoundedChannelState, type BoundedChannelSubscription, type ChannelCapacityReason,
  type ChannelQueuePolicy, type Codec,
} from "./channel-broker-contract.ts"

// Each subscription owns encoded waiting frames and one sequential reader.
export function boundedChannelSubscription<T>(
  target: EventTarget | undefined, signal: AbortSignal, codec: Codec<T>,
  policy: ChannelQueuePolicy, release: () => void,
): BoundedChannelSubscription<T> {
  const queue: string[] = []
  let bytes = 0
  let state: BoundedChannelState = { status: target ? "active" : "canceled" }
  let released = !target
  let abortAttached = false
  let reading = false
  let capacityRejected = false
  let pending: { resolve: (payload: string | undefined) => void; reject: (error: Error) => void } | undefined
  const done = (): IteratorResult<T> => ({ done: true, value: undefined })
  const detachAbort = () => {
    if (!abortAttached) return
    abortAttached = false
    signal.removeEventListener("abort", cancel)
  }
  const detach = () => {
    if (released) return
    released = true
    target?.removeEventListener("frame", onFrame)
    target?.removeEventListener("close", close)
    release()
  }
  const discard = () => { queue.length = 0; bytes = 0 }
  const rejectCapacity = (): ChannelCapacityError | undefined => {
    if (state.status !== "reconciliation_required" || capacityRejected) return
    capacityRejected = true
    return new ChannelCapacityError(state.reason)
  }
  const overflow = (reason: ChannelCapacityReason) => {
    if (state.status !== "active") return
    state = { status: "reconciliation_required", reason }
    discard()
    detach()
    detachAbort()
    const reader = pending
    pending = undefined
    const error = reader ? rejectCapacity() : undefined
    if (error) reader?.reject(error)
  }
  const cancel = () => {
    if (state.status !== "reconciliation_required") state = { status: "canceled" }
    discard()
    detach()
    detachAbort()
    const reader = pending
    pending = undefined
    reader?.resolve(undefined)
  }
  const close = () => {
    if (state.status !== "active") return
    state = { status: "closed" }
    detach()
    if (queue.length === 0) detachAbort()
    const reader = pending
    pending = undefined
    reader?.resolve(undefined)
  }
  const onFrame = (event: Event) => {
    if (state.status !== "active") return
    const payload = (event as CustomEvent<string>).detail
    const charge = encodedFrameCharge(payload)
    if (charge > policy.maxFrameBytes) { overflow("frame_bytes"); return }
    if (pending) {
      const reader = pending
      pending = undefined
      reader.resolve(payload)
      return
    }
    if (queue.length >= policy.maxFrames) { overflow("queue_count"); return }
    if (charge > policy.maxQueueBytes - bytes) { overflow("queue_bytes"); return }
    queue.push(payload)
    bytes += charge
  }
  const gate = () => {
    const error = rejectCapacity()
    if (error) throw error
    return state.status !== "canceled" && state.status !== "reconciliation_required"
  }
  const iterator: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]: () => iterator,
    async next() {
      if (reading) throw new Error("A subscription already has a pending next()")
      reading = true
      try {
        if (!gate()) return done()
        let payload = queue.shift()
        if (payload !== undefined) bytes -= encodedFrameCharge(payload)
        else if (state.status === "active") {
          payload = await new Promise<string | undefined>((resolve, reject) => { pending = { resolve, reject } })
        }
        if (!gate() || payload === undefined) return done()
        const value = codec.decode(payload)
        if (!gate()) return done()
        return { done: false, value }
      } finally {
        reading = false
        if (state.status === "closed" && queue.length === 0) detachAbort()
      }
    },
    async return() { cancel(); return done() },
    async throw(error?: unknown) { cancel(); throw error },
  }
  if (target) {
    target.addEventListener("frame", onFrame)
    target.addEventListener("close", close)
    abortAttached = true
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
  }
  return { iterable: iterator, get state() { return state }, cancel }
}
