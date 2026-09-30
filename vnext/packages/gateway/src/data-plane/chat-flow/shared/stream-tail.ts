import { utf8ByteLength } from "../../../shared/utf8.ts"

/** Bounds are absolute from the first terminal candidate, never idle resets. */
export const STREAM_TAIL_TIMEOUT_MS = 1_000
export const STREAM_TAIL_MAX_FRAMES = 256
export const STREAM_TAIL_MAX_BYTES = 1_048_576
export const STREAM_CLEANUP_TIMEOUT_MS = 1_000

export class StreamTailError extends Error {
  constructor() { super("Upstream stream exceeded the terminal observation limit.") }
}

export class StreamTail {
  private deadline: number | undefined
  private frames = 0
  private bytes = 0
  private signal: AbortSignal | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: { reject: (error: Error) => void } | undefined
  private failure: Error | undefined
  private disposed = false
  private readonly onAbort = (): void => this.interrupt(new Error("Response cancelled."))

  start(): void {
    if (this.deadline !== undefined || this.disposed || this.failure) return
    this.deadline = Date.now() + STREAM_TAIL_TIMEOUT_MS
    this.timer = setTimeout(() => this.interrupt(new StreamTailError()), STREAM_TAIL_TIMEOUT_MS)
  }

  observe(value: unknown): void {
    if (this.deadline === undefined) return
    this.frames++
    this.bytes += utf8ByteLength(JSON.stringify(value) ?? "")
    if (this.frames > STREAM_TAIL_MAX_FRAMES || this.bytes > STREAM_TAIL_MAX_BYTES || Date.now() >= this.deadline) throw new StreamTailError()
  }

  next<T>(iterator: AsyncIterator<T>, signal?: AbortSignal): Promise<IteratorResult<T>> {
    if (this.disposed || signal?.aborted) return Promise.reject(new Error("Response cancelled."))
    if (this.deadline !== undefined && Date.now() >= this.deadline && !this.failure) this.interrupt(new StreamTailError())
    if (this.failure) return Promise.reject(this.failure)
    if (this.pending) return Promise.reject(new Error("Concurrent stream reads are not supported."))
    if (this.signal !== signal) {
      this.signal?.removeEventListener("abort", this.onAbort)
      this.signal = signal
      signal?.addEventListener("abort", this.onAbort, { once: true })
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      const pending = { reject: (error: Error) => { this.pending = undefined; reject(error) } }
      this.pending = pending
      try {
        // Each read has one settlement pair. A shared never-settling abort
        // Promise would retain one reaction for every completed stream frame.
        Promise.resolve(iterator.next()).then(value => {
          if (this.pending !== pending) return
          this.pending = undefined
          resolve(value)
        }, error => {
          if (this.pending !== pending) return
          this.pending = undefined
          reject(error)
        })
      } catch (error) {
        if (this.pending === pending) { this.pending = undefined; reject(error) }
      }
    })
  }

  dispose(): void {
    this.disposed = true
    this.clearObservation()
    if (this.pending) this.pending.reject(new Error("Response cancelled."))
  }

  private clearObservation(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.signal?.removeEventListener("abort", this.onAbort)
    this.signal = undefined
  }

  private interrupt(error: Error): void {
    this.failure ??= error
    this.clearObservation()
    this.pending?.reject(this.failure)
  }
}

/** A hostile iterator can queue return() behind a never-settling next().
 * Stop pulling, request cancellation, and bound cleanup ownership explicitly. */
export async function closeStream(iterator: AsyncIterator<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => iterator.return?.()).then(() => true, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), STREAM_CLEANUP_TIMEOUT_MS) }),
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

export async function settleStreamMetadata<T>(promise: Promise<T>): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(value => ({ settled: true as const, value }), () => ({ settled: false as const })),
      new Promise<{ settled: false }>(resolve => { timer = setTimeout(() => resolve({ settled: false }), STREAM_CLEANUP_TIMEOUT_MS) }),
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
