/** A tee's other branch may keep reading after the client cancels. Propagate
 * the actual client's cancellation to the shared upstream signal first. */
export class ClientDisconnect {
  readonly controller = new AbortController()
  private readonly onAbort = (): void => { this.controller.abort(this.source.reason) }
  constructor(private readonly source: AbortSignal) {
    if (source.aborted) this.onAbort()
    else source.addEventListener("abort", this.onAbort, { once: true })
  }
  wrap(response: Response): Response {
    const source = response.body
    const cleanup = (): void => this.source.removeEventListener("abort", this.onAbort)
    if (!source) { cleanup(); return response }
    const reader = source.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) { cleanup(); controller.close() }
          else controller.enqueue(next.value)
        } catch (error) { cleanup(); controller.error(error) }
      },
      cancel: reason => {
        this.controller.abort(reason)
        cleanup()
        // tee cancellation resolves only after the background reader stops.
        void reader.cancel(reason).catch(() => {})
      },
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}
