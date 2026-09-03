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
  LlmEventResult,
} from '@vibe-llm/protocols/common'
import {
  SourceStreamState,
  eventResultMetadata,
  finalModelIdentity,
  normalizeStreamEventModel,
  performanceTargetFromTranslatorPair,
  recordPerformance,
  recordUsage,
} from '../shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import type { DumpAccumulator } from '../../../shared/dump/accumulator.ts'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'

type HubProtocol = 'responses' | 'messages' | 'chat_completions'

interface ModelBearingEvent {
  model?: unknown
  modelVersion?: unknown
  response?: { model?: unknown }
  message?: { model?: unknown }
}

/**
 * Observe hub protocol frames without changing them. Gemini's non-streaming
 * cross-protocol result retains ProtocolFrame wrappers for the hub reassembler;
 * its usage and provider model must therefore be read from `frame.event`, not
 * from the wrapper or through Gemini's bare-event stream bridge.
 */
export async function* consumeHubFramesWithState(
  events: AsyncIterable<ProtocolFrame<unknown>>,
  state: SourceStreamState,
  dump?: DumpAccumulator | null,
  hubProtocol?: HubProtocol,
): AsyncGenerator<ProtocolFrame<unknown>> {
  try {
    for await (const frame of events) {
      if (frame.type === 'event') {
        const event = frame.event as ModelBearingEvent
        state.rememberModelKey(
          event.model ?? event.modelVersion ?? event.response?.model ?? event.message?.model,
        )
        state.rememberUsage(frame.event)
        if (hubProtocol) state.rememberFailure(frame.event, hubProtocol)
      }
      dump?.frame(frame)
      yield frame
    }
  } catch (err) {
    state.failedAfter()
    dump?.failed(err)
    throw err
  }
}

/**
 * Drain an `AsyncIterable<unknown>` of bare gemini events while observing
 * model-key + usage into `state`. Throws are propagated AFTER setting
 * `state.failedAfter()` so respond-telemetry persists `isError=true`.
 */
export async function* consumeWithState(
  events: AsyncIterable<unknown>,
  state: SourceStreamState,
  dump?: DumpAccumulator | null,
): AsyncGenerator<unknown> {
  try {
    for await (const evt of events) {
      const e = evt as { modelVersion?: unknown; model?: unknown }
      state.rememberModelKey(e.modelVersion ?? e.model)
      const normalized = normalizeStreamEventModel(evt, state.publicModel)
      state.rememberUsage(normalized)
      dump?.frame(eventFrame(normalized) as ProtocolFrame<unknown>)
      yield normalized
    }
  } catch (err) {
    state.failedAfter()
    dump?.failed(err)
    throw err
  }
}

export async function persistFromEventResult(
  result: LlmEventResult<unknown>,
  state: SourceStreamState,
  telemetryCtx: TelemetryRequestContext | undefined,
  dump?: DumpAccumulator | null,
): Promise<void> {
  const md = await eventResultMetadata(result)
  const finalIdentity = result.finalMetadata
    ? md.modelIdentity
    : finalModelIdentity(md.modelIdentity, state.modelKey, result.resolveModelIdentity)
  if (dump) {
    if (state.failed) dump.failed('gemini stream failed')
    else dump.success(finalIdentity, state.usage.tokens)
  }
  if (telemetryCtx) {
    await recordUsage(telemetryCtx, finalIdentity, state.usage.tokens)
    await recordPerformance(
      telemetryCtx,
      md.performance,
      state.failed,
      undefined,
      performanceTargetFromTranslatorPair(finalIdentity),
    )
  }
}
