import type { ProtocolFrame } from "@vibe-core/result"
import type { LlmEventResult } from "@vibe-llm/protocols/common"

/** Some translators return on finish_reason before a trailing usage chunk.
 * Keep ownership of the upstream iterator and finish reading its usage before
 * exposing the translated terminal event or settling request telemetry. */
export async function* translateStream(
  frames: AsyncIterable<ProtocolFrame<unknown>>,
  translate: NonNullable<LlmEventResult<unknown>["translateEvents"]>,
  signal: AbortSignal | undefined,
  model: string | undefined,
): AsyncGenerator<unknown> {
  const iterator = frames[Symbol.asyncIterator]()
  async function* events(): AsyncGenerator<unknown> {
    while (!signal?.aborted) {
      const next = await iterator.next()
      if (next.done) return
      if (next.value.type === "event") yield next.value.event
    }
  }
  const pending: unknown[] = []
  try {
    for await (const event of translate(events(), { signal: signal ?? new AbortController().signal, model })) {
      const type = typeof event === "object" && event !== null ? (event as { type?: unknown }).type : undefined
      if (type === "error" || type === "response.failed") {
        if (!signal?.aborted) yield event
        return
      }
      const value = event as { choices?: Array<{ finish_reason?: unknown }>; delta?: { stop_reason?: unknown } }
      const completes = ["message_stop", "response.completed", "response.incomplete"].includes(String(type))
        || value?.choices?.some((choice) => choice.finish_reason != null)
        || (type === "message_delta" && value.delta?.stop_reason != null)
      if (completes || pending.length > 0) pending.push(event)
      else if (!signal?.aborted) yield event
    }
    while (!signal?.aborted) {
      const next = await iterator.next()
      if (next.done) break
      if (next.value.type === "event") {
        const event = next.value.event as { type?: string; message?: string; error?: { message?: string }; response?: { error?: { message?: string } } }
        if (event.type === "error" || event.type === "response.failed" || event.error != null) {
          throw new Error(event.message ?? event.error?.message ?? event.response?.error?.message ?? "Upstream stream failed.")
        }
      }
    }
    if (!signal?.aborted) yield* pending
  } finally {
    await iterator.return?.()
  }
}
