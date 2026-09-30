import type { ProtocolFrame } from "@vibe-core/result"
import type { EventResultMetadata, LlmEventResult, PerformanceTelemetryContext, TelemetryModelIdentity, TranslatedLlmEventResult } from "@vibe-llm/protocols/common"

/** Explicit producer fixtures fail if a test accidentally exercises its unused adapter. */
export function translatedFixture(
  producer: TranslatedLlmEventResult["producer"],
  events: AsyncIterable<ProtocolFrame<unknown>>,
  modelIdentity: TelemetryModelIdentity,
  performance?: PerformanceTelemetryContext,
  finalMetadata?: Promise<EventResultMetadata>,
  translateBody?: LlmEventResult<unknown>["translateBody"],
  translateEvents?: LlmEventResult<unknown>["translateEvents"],
  resolveModelIdentity?: LlmEventResult<unknown>["resolveModelIdentity"],
): TranslatedLlmEventResult {
  return {
    type: "events", producer, events, modelIdentity, performance, finalMetadata, resolveModelIdentity,
    translateBody: translateBody ?? (() => { throw new Error("Unexpected fixture body translation") }),
    translateEvents: translateEvents ?? (() => { throw new Error("Unexpected fixture event translation") }),
  }
}
