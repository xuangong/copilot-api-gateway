/**
 * Pure helpers for constructing telemetry payloads inside `attempt.ts`.
 * Kept free of I/O so unit tests can drive them with stub bindings.
 */
import {
  llmEventResult,
  type LlmEventResult,
  type PerformanceTelemetryContext,
  type TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
import { type ProtocolFrame } from '@vibe-core/result'
import { parseTargetStreamFrames } from '@vibe-core/result/parse'
import type { ProviderResponse } from '@vibe-llm/provider-llm'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'
import { withUpstreamTelemetry } from './upstream-telemetry.ts'

/**
 * Minimal shape this module reads from a `LlmProviderBinding`. The live
 * `LlmProviderBinding` (from `@vibe-llm/provider-llm`) has:
 *   - `upstream: string` — the upstream's name
 *   - `model: BindingModel` — `{ id, providerModelKey?, ..., cost? }`
 *   - `provider: LlmModelProvider` — exposes `getPricingForModelKey(k)`
 *
 * Tests can substitute any structurally-compatible object via `as never` cast.
 */
export interface AttemptBindingShape {
  readonly upstream: string
  readonly model: { readonly id: string; readonly providerModelKey?: string }
  readonly provider: {
    readonly getPricingForModelKey: (k: string) => unknown | null
  }
  readonly enabledFlags?: ReadonlySet<string>
}

export function initialProviderModelKey(binding: AttemptBindingShape, publicModel: string): string {
  return binding.model.providerModelKey ?? publicModel
}

export interface TelemetryIdentityInput {
  readonly incomingModel: string
  readonly publicModel: string
}

export function telemetryModelIdentity(
  binding: AttemptBindingShape,
  modelKey: string,
  input: TelemetryIdentityInput,
): TelemetryModelIdentity {
  return {
    incomingModel: input.incomingModel,
    model: input.publicModel,
    upstream: binding.upstream,
    modelKey,
    cost: (binding.provider.getPricingForModelKey(modelKey) ?? null) as TelemetryModelIdentity['cost'],
  }
}

export function modelIdentityResolver(
  binding: AttemptBindingShape,
  input: TelemetryIdentityInput,
): (modelKey: string) => TelemetryModelIdentity {
  return (modelKey) => telemetryModelIdentity(binding, modelKey, input)
}

export function upstreamPerformanceContext(
  telemetryCtx: TelemetryRequestContext,
  binding: AttemptBindingShape,
  modelKey: string,
  publicModel = binding.model.id,
): PerformanceTelemetryContext {
  return {
    keyId: telemetryCtx.apiKeyId,
    model: publicModel,
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
  readonly incomingModel: string
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
  const publicModel = args.bareModel
  const identityInput = { incomingModel: args.incomingModel, publicModel }
  const providerModelKey = initialProviderModelKey(args.binding, publicModel)
  const modelIdentity = telemetryModelIdentity(
    args.binding,
    providerModelKey,
    identityInput,
  )
  return llmEventResult(
    decorated,
    modelIdentity,
    upstreamPerformanceContext(
      args.telemetryCtx,
      args.binding,
      providerModelKey,
      publicModel,
    ),
    undefined,
    undefined,
    undefined,
    modelIdentityResolver(args.binding, identityInput),
  )
}

export { parseTargetStreamFrames }
