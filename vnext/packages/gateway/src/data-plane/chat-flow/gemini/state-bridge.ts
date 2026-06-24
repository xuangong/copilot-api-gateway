// vnext/packages/gateway/src/data-plane/chat-flow/gemini/state-bridge.ts
/**
 * Gemini SourceStreamState bridge — telemetry side-channel observer for the
 * `respond.ts` stream.
 *
 * Mirrors `messages/respond.ts:consumeWithState` but adapted for the gemini
 * source:
 *
 *   - Events are BARE `GeminiStreamEvent` (not `ProtocolFrame<MessagesStreamEvent>`).
 *     `gemini/attempt.ts` already unwrapped the hub-shape `ProtocolFrame<HubEvent>`
 *     via `unwrapHubFrames` and ran the translator's `translateEvents` to yield
 *     `GeminiResult | GeminiErrorResponse` objects directly.
 *
 *   - The corrected model key probe reads `modelVersion ?? model`. The gemini
 *     wire emits `modelVersion` on each frame (per `GeminiResult` in
 *     `translate/shared/gemini-via/types.ts`); some translators may echo
 *     `model` instead, hence the fallback.
 *
 *   - Usage capture goes through `state.rememberUsage(evt)` →
 *     `applyStreamEvent` → the gemini `usageMetadata` branch (added as a
 *     prerequisite in the same task — see `usage-extractor.ts`). The terminal
 *     gemini frame carries `usageMetadata.promptTokenCount` etc.
 *
 * The `persistFromEventResult` helper parallels the messages/responses helpers:
 * prefer `finalMetadata` over the binding-time `modelIdentity`, otherwise
 * splice in `state.modelKey` so the corrected key reaches the usage row.
 */
import type {
  EventResult,
} from '@vnext-llm/protocols/common'
import {
  SourceStreamState,
  eventResultMetadata,
  recordPerformance,
  recordUsage,
} from '../shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'

/**
 * Drain an `AsyncIterable<unknown>` of bare gemini events while observing
 * model-key + usage into `state`. Throws are propagated AFTER setting
 * `state.failedAfter()` so respond-telemetry persists `isError=true`.
 */
export async function* consumeWithState(
  events: AsyncIterable<unknown>,
  state: SourceStreamState,
): AsyncGenerator<unknown> {
  try {
    for await (const evt of events) {
      state.rememberUsage(evt)
      const e = evt as { modelVersion?: unknown; model?: unknown }
      state.rememberModelKey(e.modelVersion ?? e.model)
      yield evt
    }
  } catch (err) {
    state.failedAfter()
    throw err
  }
}

/**
 * Persist a usage row + performance row from a drained gemini `EventResult`.
 * Prefers interceptor-replaced `finalMetadata`. Otherwise the in-stream
 * observed `modelKey` (from `modelVersion`) supersedes the binding-time guess.
 *
 * Sequencing matches messages/responses respond helpers: both writes run
 * concurrently via implicit `Promise.all`-less await pair — slightly fewer
 * I/O hops but order doesn't matter here (usage and perf are independent
 * rows). The caller wraps this whole helper in `waitUntil` so it doesn't
 * block the client response.
 */
export async function persistFromEventResult(
  result: EventResult<unknown>,
  state: SourceStreamState,
  telemetryCtx: TelemetryRequestContext,
): Promise<void> {
  const md = await eventResultMetadata(result)
  const finalIdentity = result.finalMetadata
    ? md.modelIdentity
    : { ...md.modelIdentity, modelKey: state.modelKey }
  await recordUsage(telemetryCtx, finalIdentity, state.usage.tokens)
  await recordPerformance(telemetryCtx, md.performance, state.failed)
}
