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

  start(): void { this.deadline ??= Date.now() + STREAM_TAIL_TIMEOUT_MS }

  observe(value: unknown): void {
    if (this.deadline === undefined) return
    this.frames++
    this.bytes += new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength
    if (this.frames > STREAM_TAIL_MAX_FRAMES || this.bytes > STREAM_TAIL_MAX_BYTES || Date.now() >= this.deadline) throw new StreamTailError()
  }

  async next<T>(iterator: AsyncIterator<T>, signal?: AbortSignal): Promise<IteratorResult<T>> {
    if (signal?.aborted) throw new Error("Response cancelled.")
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      if (this.deadline !== undefined) timer = setTimeout(() => reject(new StreamTailError()), Math.max(0, this.deadline - Date.now()))
      if (signal) {
        onAbort = () => reject(new Error("Response cancelled."))
        signal.addEventListener("abort", onAbort, { once: true })
      }
    })
    try { return await Promise.race([iterator.next(), interrupted]) }
    finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener("abort", onAbort)
    }
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
