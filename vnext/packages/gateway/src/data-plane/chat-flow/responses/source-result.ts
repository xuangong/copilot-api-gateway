import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import type { LlmEventResult } from "@vibe-llm/protocols/common"
import type { ChatCompletionsStreamEvent } from "@vibe-llm/protocols/chat"
import type { MessagesStreamEvent } from "@vibe-llm/protocols/messages"
import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { translateStream } from "../shared/translate-stream"
import { collectChatCompletionsProtocolEventsToResult } from "../chat-completions/events/to-result"
import { collectMessagesProtocolEventsToResult } from "../messages/events/reassemble"
import { collectResponsesProtocolEventsToResult } from "./events/reassemble"

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
  const hub = result.modelIdentity.translatorPair?.hub
  // Legacy results describe the actual event domain through translatorPair,
  // not a tagged event union. Keep that trust boundary local to preparation.
  const body = hub === "chat_completions"
    ? await collectChatCompletionsProtocolEventsToResult(observed as AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>)
    : hub === "messages"
      ? await collectMessagesProtocolEventsToResult(observed as AsyncIterable<ProtocolFrame<MessagesStreamEvent>>)
      : await collectResponsesProtocolEventsToResult(observed as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>)
  const translated = await translateBody.call(result, body, { signal: upstreamAbortController.signal, model: result.modelIdentity.model })
  const status = (translated as { status?: string }).status
  yield eventFrame({ type: status === "failed" ? "response.failed" : status === "incomplete" ? "response.incomplete" : "response.completed", response: translated } as ResponsesStreamEvent)
}

async function* translatedFrames(
  result: LlmEventResult<ProtocolFrame<unknown>>,
  rawFrames: AsyncIterable<ProtocolFrame<unknown>>,
  upstreamAbortController: AbortController,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const translateEvents = result.translateEvents
  if (!translateEvents) return
  for await (const event of translateStream(rawFrames, translateEvents, upstreamAbortController.signal, result.modelIdentity.model, () => upstreamAbortController.abort())) {
    yield eventFrame(event as ResponsesStreamEvent)
  }
}

/** Preparation is lazy; the turn retains raw-iterator cleanup and settlement. */
export function prepareResponsesSource(input: ResponsesSourceInput): ResponsesSourceFrames {
  const { result, rawFrames, upstreamAbortController, observe } = input
  if (!input.wantsStream && result.translateBody) return { protocol: "responses", frames: jsonFrames(input, result.translateBody) }
  const frames = result.translateEvents ? translatedFrames(result, rawFrames, upstreamAbortController) : rawFrames as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>
  return { protocol: "responses", frames: observe(frames) }
}
