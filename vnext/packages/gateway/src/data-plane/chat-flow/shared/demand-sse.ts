import { startSseKeepalive, type SseKeepalive } from "./sse-keepalive"

const encoder = new TextEncoder()
const nativeEncodeIntoExact = encoder.encodeInto("😀", new Uint8Array(3)).read === 0
export const SSE_OUTPUT_CAPACITY = 16 * 1024

interface DemandSseOptions<T> {
  events: AsyncIterable<T>
  serialize(event: T): string | null
  errorFrame?(error: unknown): string
  terminal?(event: T): boolean
  signal?: AbortSignal
  keepalive: string
  onBytes?(bytes: number): void
  onCancel?(): void
  background?(task: Promise<void>): void
  onFinish?(cancelled: boolean): void
}

/** The queue and each encoded chunk are byte-bounded. Only one serialized
 * frame may be pending; heartbeat bytes never split that frame. */
export function demandSse<T>(options: DemandSseOptions<T>): ReadableStream<Uint8Array> {
  const iterator = options.events[Symbol.asyncIterator]()
  let pending = ""
  let offset = 0
  let terminal = false
  let failed = false
  let closed = false
  let keepalive: SseKeepalive | undefined
  let controller: ReadableStreamDefaultController<Uint8Array>
  const finish = (cancelled = false): void => {
    if (closed) return
    closed = true
    pending = ""
    keepalive?.stop()
    options.signal?.removeEventListener("abort", onAbort)
    if (!cancelled) controller.close()
    options.onFinish?.(cancelled || options.signal?.aborted === true)
  }
  const release = (): void => {
    // Async-generator cleanup can await provider/turn persistence. It must
    // continue after HTTP close, without holding the terminal pull open.
    if (iterator.return) {
      const task = Promise.resolve(iterator.return()).then(() => {}, () => {})
      options.background?.(task)
    }
  }
  const drainTerminal = (): void => {
    const task = (async () => { while (!(await iterator.next()).done) { /* terminal cleanup only */ } })().catch(() => {})
    options.background?.(task)
  }
  const onAbort = (): void => { finish(); release() }
  return new ReadableStream<Uint8Array>({
    start(target) {
      controller = target
      keepalive = startSseKeepalive(target, options.keepalive, undefined, () => !pending && !closed, options.onBytes)
      options.signal?.addEventListener("abort", onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
    },
    async pull() {
      if (closed) return
      try {
        while (!pending) {
          const next = await iterator.next()
          if (closed) return
          if (next.done) { finish(); return }
          pending = options.serialize(next.value) ?? ""
          terminal = options.terminal?.(next.value) ?? false
          offset = 0
          keepalive?.touch()
          if (terminal) keepalive?.stop()
          if (!pending && terminal) { finish(); drainTerminal(); return }
        }
      } catch (error) {
        if (closed) return
        if (!options.errorFrame) { controller.error(error); finish(true); release(); return }
        failed = true
        pending = options.errorFrame(error)
        offset = 0
        terminal = true
        keepalive?.stop()
      }
      // Each queued chunk reserves the full byte budget, including short chunks.
      // At least four bytes are needed to encode a surrogate pair atomically.
      // A previous keepalive may have consumed capacity while next() awaited.
      const capacity = Math.min(SSE_OUTPUT_CAPACITY, controller.desiredSize ?? 0)
      if (capacity < 4) return
      let bytes: Uint8Array
      if (pending.length - offset <= capacity / 3) {
        // UTF-8 uses at most three bytes per UTF-16 code unit. Ordinary
        // small frames keep their exact allocation instead of a full slot.
        bytes = encoder.encode(pending.slice(offset))
        offset = pending.length
      } else if (!nativeEncodeIntoExact) {
        // Bun 1.3 can consume half a surrogate pair in encodeInto. Bound
        // code units conservatively and encode only whole code points there.
        let end = Math.min(pending.length, offset + Math.floor(capacity / 3))
        const last = pending.charCodeAt(end - 1)
        const next = pending.charCodeAt(end)
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
        bytes = encoder.encode(pending.slice(offset, end))
        offset = end
      } else {
        const buffer = new Uint8Array(capacity)
        const encoded = encoder.encodeInto(pending.slice(offset, offset + capacity + 1), buffer)
        offset += encoded.read
        bytes = encoded.written === buffer.length ? buffer : buffer.subarray(0, encoded.written)
      }
      controller.enqueue(bytes)
      options.onBytes?.(bytes.byteLength)
      if (offset === pending.length) {
        pending = ""
        offset = 0
        if (terminal) { finish(); if (failed) release(); else drainTerminal() }
      }
    },
    cancel() {
      finish(true)
      options.onCancel?.()
      release()
    },
  }, { highWaterMark: SSE_OUTPUT_CAPACITY, size: () => SSE_OUTPUT_CAPACITY })
}
