import type { LlmEventResult } from "@vibe-llm/protocols/common"
import { closeStream, settleStreamMetadata } from "../../shared/stream-tail"
import { disposeEventProducerBody } from "../../shared/producer-ownership"

interface Resource {
  close(): Promise<boolean>
  finish(): void
}

/** Owns resources, not request outcomes. State closes before any asynchronous cleanup. */
export class ServerToolLifetime {
  private closed = false
  private incomplete = false
  private cleanup: Promise<void> | undefined
  private readonly resources = new Set<Resource>()
  private readonly reads = new Set<(error: Error) => void>()
  private readonly onAbort = (): void => { void this.close().catch(() => {}) }
  private onClosed: (() => void) | undefined

  constructor(private readonly disposeState: () => undefined, private readonly signal?: AbortSignal) {
    signal?.addEventListener("abort", this.onAbort, { once: true })
    if (signal?.aborted) this.onAbort()
  }

  get isClosed(): boolean { return this.closed }
  assertOpen(): void { if (this.closed) throw new Error("Server-tool invocation is closed") }
  recordIncompleteCleanup(): void { this.incomplete = true }
  onClose(callback: () => void): void {
    if (this.closed) {
      callback()
      return
    }
    this.onClosed = callback
  }

  private resource(operation: () => Promise<boolean>): Resource {
    let closing: Promise<boolean> | undefined
    const resource: Resource = {
      finish: () => { this.resources.delete(resource) },
      close: () => closing ??= Promise.resolve().then(operation).catch(() => false).then(complete => {
        if (!complete) this.recordIncompleteCleanup()
        resource.finish()
        return complete
      }),
    }
    this.resources.add(resource)
    if (this.closed) void resource.close()
    return resource
  }

  trackIterator(iterator: AsyncIterator<unknown>): Resource {
    return this.resource(() => closeStream(iterator))
  }

  /** A separate pending-read registration is released on every settlement, not accumulated per frame. */
  wait<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = (error: Error): void => { this.reads.delete(cancel); reject(error) }
      if (this.closed) cancel(new Error("Server-tool invocation is closed"))
      else this.reads.add(cancel)
      operation.then(value => {
        this.reads.delete(cancel)
        if (this.closed) reject(new Error("Server-tool invocation is closed"))
        else resolve(value)
      }, error => { this.reads.delete(cancel); reject(error) })
    })
  }

  /** Keep a pending factory in cleanup ownership; a result arriving after close is never published. */
  awaitResult<T>(operation: Promise<T>, discardLate: (value: T) => Promise<void>, acquire: (value: T) => T): Promise<T> {
    const pending = operation.then(async value => {
      try {
        if (this.closed) { await discardLate(value); return value }
        return acquire(value)
      } finally { resource.finish() }
    }, error => { resource.finish(); throw error })
    const resource = this.resource(async () => (await settleStreamMetadata(pending.then(() => {}))).settled)
    return this.wait(pending)
  }

  private ownEvents<T>(source: AsyncIterable<T>, discard?: () => void | Promise<void>): { events: AsyncIterable<T>; discardProducer: () => Promise<void> } {
    const iterator = (() => {
      try { return source[Symbol.asyncIterator]() } catch (error) {
        this.resource(() => disposeEventProducerBody(discard))
        throw error
      }
    })()
    const resource = this.resource(async () => {
      const complete = await Promise.all([closeStream(iterator), disposeEventProducerBody(discard)])
      return complete.every(Boolean)
    })
    const events: AsyncIterable<T> = { [Symbol.asyncIterator]: () => ({
      next: async () => {
        this.assertOpen()
        const step = await this.wait(Promise.resolve().then(() => iterator.next()))
        if (step.done) resource.finish()
        return step
      },
      return: async () => {
        if (!(await resource.close())) throw new Error("Server-tool producer cleanup incomplete")
        return { done: true, value: undefined }
      },
    }) }
    return { events, discardProducer: async () => {
      if (!(await resource.close())) throw new Error("Server-tool producer cleanup incomplete")
    } }
  }

  ownSource<T>(source: AsyncIterable<T>): AsyncIterable<T> { return this.ownEvents(source).events }

  ownProducer<T>(result: LlmEventResult<T>): LlmEventResult<T> {
    // Preserve the native/translated producer correlation while wrapping its actual frame domain.
    if (result.producer) return { ...result, ...this.ownEvents(result.events, result.discardProducer) }
    return { ...result, ...this.ownEvents(result.events, result.discardProducer) }
  }

  async discardLate<T>(result: LlmEventResult<T>): Promise<void> {
    const owned = this.ownProducer(result)
    await owned.discardProducer?.()
  }

  close(): Promise<void> {
    if (this.cleanup) return this.cleanup
    // Publish the one cleanup promise before synchronous callbacks can reenter close().
    this.cleanup = Promise.resolve().then(async () => {
      await Promise.all([...this.resources].map(resource => resource.close()))
      if (this.incomplete) throw new Error("Server-tool resource cleanup incomplete")
    })
    this.closed = true
    const callback = this.onClosed
    this.onClosed = undefined
    this.signal?.removeEventListener("abort", this.onAbort)
    try { this.disposeState() } catch { this.recordIncompleteCleanup() }
    for (const reject of this.reads) reject(new Error("Server-tool invocation is closed"))
    this.reads.clear()
    try { callback?.() } catch { this.recordIncompleteCleanup() }
    return this.cleanup
  }

  /** Explicit methods also work before the generator's first pull. */
  wrap<T>(generator: AsyncGenerator<T>): AsyncGenerator<T> {
    const resource = this.trackIterator(generator)
    return {
      [Symbol.asyncIterator]() { return this },
      [Symbol.asyncDispose]: () => this.close(),
      next: async value => {
        if (this.closed) { await this.close(); return { done: true, value: undefined } }
        try {
          const step = await this.wait(generator.next(value))
          if (step.done) { resource.finish(); await this.close() }
          return step
        } catch (error) {
          await this.close().catch(() => {})
          throw error
        }
      },
      return: async value => { await this.close(); return { done: true, value } },
      throw: async error => { await this.close().catch(() => {}); throw error },
    }
  }
}

/** Slot materialization can close its iterator, but cannot dispose the invocation. */
export type ServerToolSlotLifetime = Pick<ServerToolLifetime, "assertOpen" | "wait" | "trackIterator" | "recordIncompleteCleanup">
