import type { ProtocolFrame } from "@vibe-core/result"
import type { OutputProtocol } from "@vibe-llm/protocols/common"
import type { ProviderRequest, ProviderResponse } from "@vibe-llm/provider-llm"
import type { PerformanceRecorder, UpstreamObservation } from "../../observability/performance-recorder"

const observations = new WeakMap<ProviderResponse, UpstreamObservation>()

/** Starts at provider dispatch, includes headers and body occupancy, excludes routing. */
export async function fetchWithPerformance(
  recorder: PerformanceRecorder | undefined,
  protocol: OutputProtocol,
  request: ProviderRequest,
  fetch: () => Promise<ProviderResponse>,
): Promise<ProviderResponse> {
  if (!recorder) return fetch()
  const observation = recorder.beginUpstream(protocol, request.payload)
  const finish = (): void => { observation.finish(); request.signal?.removeEventListener("abort", finish) }
  request.signal?.addEventListener("abort", finish, { once: true })
  try {
    const result = await fetch()
    if (!result.body) { finish(); return result }
    const reader = result.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) { finish(); controller.close() }
          else controller.enqueue(next.value)
        } catch (error) { finish(); controller.error(error) }
      },
      async cancel(reason) { finish(); await reader.cancel(reason) },
    })
    const wrapped = { ...result, body }
    observations.set(wrapped, observation)
    return wrapped
  } catch (error) { finish(); throw error }
}

export function observeUpstreamJson(response: ProviderResponse, json: unknown): void { observations.get(response)?.json(json) }

export async function* observeUpstreamFrames<T>(response: ProviderResponse, frames: AsyncIterable<ProtocolFrame<T>>, synthetic = false): AsyncGenerator<ProtocolFrame<T>> {
  const observation = observations.get(response)
  for await (const frame of frames) {
    if (!synthetic && frame.type === "event") observation?.observe(frame.event)
    if (frame.type === "done") observation?.done()
    yield frame
  }
  observation?.endFrames()
}
