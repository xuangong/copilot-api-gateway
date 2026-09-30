import { collectProducerResult } from "../shared/collect-producer-result"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { eventProducerProtocol, type LlmEventResult, type TranslatedLlmEventResult } from "@vibe-llm/protocols/common"
import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { translateStream } from "../shared/translate-stream"

export interface ResponsesSourceFrames {
  readonly protocol: "responses"
  readonly frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>
}

export interface ResponsesSourceInput {
  readonly result: LlmEventResult<ProtocolFrame<unknown>>
  readonly rawFrames: AsyncIterable<ProtocolFrame<unknown>>
  readonly wantsStream: boolean
  readonly upstreamAbortController: AbortController
  readonly observe: <T>(frames: AsyncIterable<ProtocolFrame<T>>) => AsyncIterable<ProtocolFrame<T>>
}

async function* jsonFrames(
  input: ResponsesSourceInput,
  translateBody: NonNullable<LlmEventResult<unknown>["translateBody"]>,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const { result, rawFrames, upstreamAbortController, observe } = input
  const observed = observe(rawFrames)
  const body = await collectProducerResult(observed, eventProducerProtocol(result, "responses"))
  const translated = await translateBody.call(result, body, { signal: upstreamAbortController.signal, model: result.modelIdentity.model })
  const status = (translated as { status?: string }).status
  yield eventFrame({ type: status === "failed" ? "response.failed" : status === "incomplete" ? "response.incomplete" : "response.completed", response: translated } as ResponsesStreamEvent)
}

async function* translatedFrames(
  result: TranslatedLlmEventResult,
  rawFrames: AsyncIterable<ProtocolFrame<unknown>>,
  upstreamAbortController: AbortController,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const translateEvents = result.translateEvents
  for await (const event of translateStream(rawFrames, translateEvents, upstreamAbortController.signal, result.modelIdentity.model, () => upstreamAbortController.abort())) {
    yield eventFrame(event as ResponsesStreamEvent)
  }
}

/** Preparation is lazy; the turn retains raw-iterator cleanup and settlement. */
export function prepareResponsesSource(input: ResponsesSourceInput): ResponsesSourceFrames {
  const { result, rawFrames, upstreamAbortController, observe } = input
  eventProducerProtocol(result, "responses")
  if (!input.wantsStream && result.producer) return { protocol: "responses", frames: jsonFrames(input, result.translateBody) }
  const frames = result.producer ? translatedFrames(result, rawFrames, upstreamAbortController) : rawFrames as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>
  return { protocol: "responses", frames: observe(frames) }
}
