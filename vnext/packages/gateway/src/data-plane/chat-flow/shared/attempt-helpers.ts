/**
 * Pure helpers for constructing telemetry payloads inside `attempt.ts`.
 * Kept free of I/O so unit tests can drive them with stub bindings.
 */
import {
  llmEventResult,
  type LlmEventResult,
  type PerformanceTelemetryContext,
  type TelemetryModelIdentity,
} from '@vnext-llm/protocols/common'
import { type ProtocolFrame } from '@vnext-gateway/result'
import { parseTargetStreamFrames } from '@vnext-gateway/result/parse'
import type { ProviderResponse } from '@vnext/provider'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'
import { withUpstreamTelemetry } from './upstream-telemetry.ts'

/**
 * Minimal shape this module reads from a `ProviderBinding`. The live
 * `ProviderBinding` (from `@vnext/provider`) has:
 *   - `upstream: string` — the upstream's name
 *   - `model: BindingModel` — `{ id, ..., cost? }`
 *   - `provider: ModelProvider` — exposes `getPricingForModelKey(k)`
 *
 * Tests can substitute any structurally-compatible object via `as never` cast.
 */
export interface AttemptBindingShape {
  readonly upstream: string
  readonly model: { readonly id: string }
  readonly provider: {
    readonly getPricingForModelKey: (k: string) => unknown | null
  }
}

export function telemetryModelIdentity(
  binding: AttemptBindingShape,
  modelKey: string,
): TelemetryModelIdentity {
  return {
    model: binding.model.id,
    upstream: binding.upstream,
    modelKey,
    cost: (binding.provider.getPricingForModelKey(modelKey) ?? null) as TelemetryModelIdentity['cost'],
  }
}

export function upstreamPerformanceContext(
  telemetryCtx: TelemetryRequestContext,
  binding: AttemptBindingShape,
  modelKey: string,
): PerformanceTelemetryContext {
  return {
    keyId: telemetryCtx.apiKeyId,
    model: binding.model.id,
    upstream: binding.upstream,
    modelKey,
    stream: telemetryCtx.isStreaming,
    runtimeLocation: telemetryCtx.runtimeLocation,
  }
}

export interface ProviderResponseToExecuteResultArgs<T> {
  readonly providerResp: ProviderResponse
  readonly binding: AttemptBindingShape
  readonly telemetryCtx: TelemetryRequestContext
  readonly bareModel: string
  readonly toEvents: (body: ReadableStream<Uint8Array>) => AsyncIterable<ProtocolFrame<T>>
  readonly protocol: 'chat_completions' | 'messages' | 'responses'
  readonly abortSignal?: AbortSignal
}

/**
 * 2xx provider response → `LlmEventResult` populated with telemetry channel.
 * Wraps the body via the rewritten `withUpstreamTelemetry` so a `finalMetadata`
 * promise (for downstream interceptors that DON'T replace the stream — but
 * may want to read the terminal-frame state) is exposed; pass-through callers
 * leave `finalMetadata` undefined unless they explicitly intend replacement
 * semantics.
 */
export function providerResponseToExecuteResult<T>(
  args: ProviderResponseToExecuteResultArgs<T>,
): LlmEventResult<ProtocolFrame<T>> {
  if (!args.providerResp.body) throw new Error('upstream returned empty body')
  const events = args.toEvents(args.providerResp.body)
  const { events: decorated } = withUpstreamTelemetry(events, {
    abortSignal: args.abortSignal,
    protocol: args.protocol,
  })
  return llmEventResult(
    decorated,
    telemetryModelIdentity(args.binding, args.bareModel),
    upstreamPerformanceContext(args.telemetryCtx, args.binding, args.bareModel),
    // No finalMetadata: pass-through path. Interceptors that replace the stream
    // construct their own LlmEventResult with their own finalMetadata.
  )
}

export { parseTargetStreamFrames }
