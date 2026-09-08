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
  let terminal: unknown
  try {
    for await (const event of translate(events(), { signal: signal ?? new AbortController().signal, model })) {
      const type = typeof event === "object" && event !== null ? (event as { type?: unknown }).type : undefined
      if (["message_stop", "response.completed", "response.incomplete", "response.failed"].includes(String(type))) terminal = event
      else yield event
    }
    while (!signal?.aborted) {
      if ((await iterator.next()).done) break
    }
    if (terminal !== undefined && !signal?.aborted) yield terminal
  } finally {
    await iterator.return?.()
  }
}
