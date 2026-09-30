import { assertNativeEventResult, eventProducerProtocol, type LlmEventResult, type NativeLlmEventResult, type TranslatorProtocol } from "@vibe-llm/protocols/common"
import { closeStream, settleStreamMetadata } from "./stream-tail"

/** Validation rejects ownership as well as the producer's type. Never pull an
 * unsupported frame, and never classify this internal failure as client cancel. */
export async function discardEventProducer(result: LlmEventResult<unknown>, abortUpstream?: () => void): Promise<void> {
  try { abortUpstream?.() } catch { /* Cleanup must preserve the producer error. */ }
  const disposal = disposeEventProducerBody(result.discardProducer)
  const close = async (): Promise<void> => {
    try { await closeStream(result.events[Symbol.asyncIterator]()) } catch { /* Iterator acquisition can fail too. */ }
  }
  await Promise.all([disposal, close()])
}

export async function validateEventProducer<T>(result: LlmEventResult<T>, source: TranslatorProtocol, abortUpstream?: () => void): Promise<TranslatorProtocol> {
  try { return eventProducerProtocol(result, source) } catch (error) {
    await discardEventProducer(result, abortUpstream)
    throw error
  }
}

export async function requireNativeEventResult<T>(result: LlmEventResult<T>, abortUpstream?: () => void): Promise<NativeLlmEventResult<T>> {
  try { assertNativeEventResult(result); return result } catch (error) {
    await discardEventProducer(result, abortUpstream)
    throw error
  }
}

/** Capture this terminal's body, never a mutable multi-turn response variable.
 * return() on an unstarted async generator does not run its finally block. */
export function upstreamBodyDisposal(body: ReadableStream<Uint8Array>): () => Promise<void> {
  return () => body.cancel()
}

export async function disposeEventProducerBody(discard: LlmEventResult<unknown>["discardProducer"]): Promise<boolean> {
  if (!discard) return true
  return (await settleStreamMetadata(Promise.resolve().then(discard))).settled
}
