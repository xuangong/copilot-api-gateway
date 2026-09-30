import { validateEventProducer } from "../shared/producer-ownership"
import { collectProducerResult } from "../shared/collect-producer-result"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { type LlmEventResult, type NativeLlmEventResult, type TranslateBodyContext } from "@vibe-llm/protocols/common"
import { responsesResultToEvents, type ResponsesResult, type ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { translateStream } from "../shared/translate-stream"

type Frames = AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>
type EventResult = LlmEventResult<ProtocolFrame<ResponsesStreamEvent>>

/** Only interceptors that consume source events replace the producer domain. */
export async function materializeResponsesSource(result: EventResult, wantsStream: boolean, signal?: AbortSignal, abortUpstream?: () => void): Promise<NativeLlmEventResult<ProtocolFrame<ResponsesStreamEvent>>> {
  await validateEventProducer(result, "responses", abortUpstream)
  if (!result.producer) return result
  const { producer: _producer, translateBody, translateEvents, events: hubFrames, ...metadata } = result
  return {
    ...metadata,
    events: (async function* () {
      if (!wantsStream) {
        const body = await collectProducerResult(hubFrames, result.producer.protocol)
        const translated = await translateBody(body, { signal, model: result.modelIdentity.model })
        // Preserve the body adapter's envelope fields while exposing a full
        // lifecycle for server-tool dispatch and compaction's item collector.
        yield* responsesResultToEvents(translated as ResponsesResult, { genericOutputItems: true })
        return
      }
      for await (const event of translateStream(hubFrames, translateEvents, signal, result.modelIdentity.model)) {
        // This is the source translator output boundary, never a hub-frame cast.
        yield eventFrame(event as ResponsesStreamEvent)
      }
    })(),
  }
}

/** Stream-only transforms retain the independent JSON body adapter. */
export async function mapResponsesSourceFrames(result: EventResult, transform: (frames: Frames) => Frames, abortUpstream?: () => void): Promise<EventResult> {
  await validateEventProducer(result, "responses", abortUpstream)
  if (!result.producer) return { ...result, events: transform(result.events) }
  const translateEvents = result.translateEvents
  return {
    ...result,
    translateEvents: async function* (events: AsyncIterable<unknown>, context: TranslateBodyContext) {
      async function* sourceFrames(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
        for await (const event of translateEvents(events, context)) yield eventFrame(event as ResponsesStreamEvent)
      }
      for await (const frame of transform(sourceFrames())) if (frame.type === "event") yield frame.event
    },
  }
}
