import type { LlmEventResult, LlmExecuteResult, NativeLlmEventResult } from "@vibe-llm/protocols/common"
import type { WebSearchExecutionScope } from "../../../tools/web-search/execution-scope"
import { disposeEventProducerBody, requireNativeEventResult } from "../../shared/producer-ownership"
import { closeStream, settleStreamMetadata } from "../../shared/stream-tail"

type OwnedRunResult<T> = Exclude<LlmExecuteResult<T>, { type: "events" }> | NativeLlmEventResult<T>

interface Producer {
  close(): Promise<boolean>
}

/** Chat's search result owns its concrete producer and one pending run, never outcomes. */
export class ChatWebSearchResultOwner<T> {
  private closed = false
  private incomplete = false
  private cleanup: Promise<void> | undefined
  private current: Producer | undefined
  private generator: AsyncIterator<T> | undefined
  private readonly pending = new Set<Promise<unknown>>()
  private readonly reads = new Set<(error: Error) => void>()
  private readonly onAbort = (): void => { void this.close().catch(() => {}) }

  constructor(private readonly search: WebSearchExecutionScope, private readonly signal?: AbortSignal, private readonly abortUpstream?: () => void) {
    signal?.addEventListener("abort", this.onAbort, { once: true })
    if (signal?.aborted) this.onAbort()
  }

  assertOpen(): void {
    if (this.closed) throw new Error("Chat web search invocation is closed")
    this.search.assertOpen()
  }

  wait<U>(operation: Promise<U>): Promise<U> {
    return new Promise<U>((resolve, reject) => {
      const cancel = (error: Error): void => { this.reads.delete(cancel); reject(error) }
      if (this.closed) cancel(new Error("Chat web search invocation is closed"))
      else this.reads.add(cancel)
      void operation.then(value => {
        this.reads.delete(cancel)
        if (this.closed) reject(new Error("Chat web search invocation is closed"))
        else resolve(value)
      }, error => { this.reads.delete(cancel); reject(error) })
    })
  }

  private ownProducer(result: NativeLlmEventResult<T>): NativeLlmEventResult<T> {
    let iterator: AsyncIterator<T>
    try { iterator = result.events[Symbol.asyncIterator]() } catch (error) {
      // Acquisition has failed; only its body remains to dispose.
      const disposal = disposeEventProducerBody(result.discardProducer)
      this.pending.add(disposal)
      void disposal.then(complete => { if (!complete) this.incomplete = true; this.pending.delete(disposal) })
      throw error
    }
    let drained = false
    let cleanup: Promise<boolean> | undefined
    const producer: Producer = {
      close: () => cleanup ??= drained ? Promise.resolve(true) : Promise.all([
        closeStream(iterator),
        disposeEventProducerBody(result.discardProducer),
      ]).then(results => results.every(Boolean)),
    }
    this.current = producer
    const events: AsyncIterable<T> = { [Symbol.asyncIterator]: () => ({
      next: async () => {
        this.assertOpen()
        const step = await this.wait(Promise.resolve().then(() => iterator.next()))
        this.assertOpen()
        if (step.done) drained = true
        return step
      },
      return: async () => {
        if (!(await producer.close())) throw new Error("Chat web search producer cleanup incomplete")
        return { done: true, value: undefined }
      },
    }) }
    return { ...result, events }
  }

  private async discardLate(result: LlmEventResult<T>): Promise<void> {
    const disposal = disposeEventProducerBody(result.discardProducer)
    let iterator: AsyncIterator<unknown> | undefined
    try { iterator = result.events[Symbol.asyncIterator]() } catch { this.incomplete = true }
    const results = await Promise.all([disposal, iterator ? closeStream(iterator) : Promise.resolve(false)])
    if (!results.every(Boolean)) this.incomplete = true
  }

  async run(factory: () => Promise<LlmExecuteResult<T>>): Promise<OwnedRunResult<T>> {
    this.assertOpen()
    if (this.current) {
      if (!(await this.current.close())) throw new Error("Chat web search producer cleanup incomplete")
      this.current = undefined
    }
    this.assertOpen()
    const operation = Promise.resolve().then(() => { this.assertOpen(); return factory() }).then(async result => {
      if (result.type !== "events") return result
      if (this.closed) { await this.discardLate(result); throw new Error("Chat web search invocation is closed") }
      // Validation owns unsupported producers' disposal; never adopt them twice.
      const native = await requireNativeEventResult(result, this.abortUpstream)
      if (this.closed) { await this.discardLate(native); throw new Error("Chat web search invocation is closed") }
      return this.ownProducer(native)
    })
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return this.wait(operation)
  }

  close(): Promise<void> {
    if (this.cleanup) return this.cleanup
    this.cleanup = Promise.resolve().then(async () => {
      const results = await Promise.all([
        settleStreamMetadata(Promise.resolve().then(() => this.search.settled())).then(result => result.settled),
        this.current?.close() ?? Promise.resolve(true),
        this.generator ? closeStream(this.generator) : Promise.resolve(true),
        ...[...this.pending].map(operation => settleStreamMetadata(operation.then(() => undefined, () => undefined)).then(result => result.settled)),
      ])
      if (this.incomplete || !results.every(Boolean)) throw new Error("Chat web search resource cleanup incomplete")
    })
    this.closed = true
    this.search.cancel()
    this.signal?.removeEventListener("abort", this.onAbort)
    for (const reject of this.reads) reject(new Error("Chat web search invocation is closed"))
    this.reads.clear()
    return this.cleanup
  }

  wrap(generator: AsyncGenerator<T>): AsyncGenerator<T> {
    this.generator = generator
    return {
      [Symbol.asyncIterator]() { return this },
      [Symbol.asyncDispose]: () => this.close(),
      next: async value => {
        if (this.closed) { await this.close(); return { done: true, value: undefined } }
        try {
          const step = await this.wait(generator.next(value))
          if (step.done) { this.generator = undefined; await this.close() }
          return step
        } catch (error) {
          void this.close().catch(() => {})
          throw error
        }
      },
      return: async value => { await this.close(); return { done: true, value } },
      throw: async error => { await this.close().catch(() => {}); throw error },
    }
  }
}
