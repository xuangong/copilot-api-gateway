export class Mutex {
  private locked = false
  private readonly waiters: Array<() => void> = []
  tryAcquire(): (() => void) | null {
    if (this.locked) return null
    this.locked = true
    return this.releaser()
  }
  async acquire(): Promise<() => void> {
    const free = this.tryAcquire()
    if (free) return free
    // The lock stays held and is handed to the next waiter.
    await new Promise<void>(resolve => this.waiters.push(resolve))
    return this.releaser()
  }
  /** Number of callers queued in `acquire` (test hook). */
  get waiting(): number { return this.waiters.length }
  /** Each holder gets a closure that releases at most once. */
  private releaser(): () => void {
    let done = false
    return () => {
      if (done) return
      done = true
      this.release()
    }
  }
  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.locked = false
  }
}

/** Serializes the scheduler tick with source connect, replace and disconnect (one process, one source). */
export const syncLock = new Mutex()

export async function withSyncLock<T>(run: () => Promise<T>): Promise<T> {
  const release = await syncLock.acquire()
  try { return await run() } finally { release() }
}
