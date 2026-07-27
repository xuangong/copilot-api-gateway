/**
 * Ported from copilot-gateway data-plane/chat/shared/gateway-ctx.ts —
 * ONLY the pieces the image_generation server-tool plugin needs.
 *
 * vNext has its own gateway ctx structure (see data-plane/chat-flow/*),
 * so we don't port the full GatewayCtx / ChatGatewayCtx / factories here.
 * Only `AttemptState` + `stampUpstreamCallStart` are extracted because
 * image_generation constructs a local per-image-op attempt state
 * (distinct from any request-scoped attempt) to record its own upstream
 * dial timing without contaminating the enclosing request's stats.
 */
import type { PerformanceTelemetryContext } from '@vibe-llm/protocols/common'
import { getRepo } from './repo/index.ts'
import type {
  PerformanceOperation,
  PerformanceRecordInput,
  PerformanceSourceApi,
  PerformanceTargetApi,
  Repo,
} from './repo/types.ts'

// Per-attempt performance state. Reset at the start of every image
// operation so a retry cannot inherit the prior attempt's slots. Numeric
// slots use `null` because a real timestamp of `0` would be ambiguous.
export interface AttemptState {
  upstreamCallStartedAt: number | null
  firstOutputTokenAt: number | null
  telemetry: PerformanceTelemetryContext | undefined
}

// Stamps at dispatch entry — pre-dial by design. The interval includes proxy
// handshake time (the user waits for it too).
export const stampUpstreamCallStart = (attempt: AttemptState) =>
  <T>(dispatch: () => Promise<T>): Promise<T> => {
    attempt.upstreamCallStartedAt = performance.now()
    return dispatch()
  }

function currentHour(): string {
  return new Date().toISOString().slice(0, 13)
}

/**
 * Record a per-sub-call performance row for the image-generation server-tool
 * shim (Spec 13-D-5-g, adaptation option C1). Each image sub-call writes its
 * OWN row under `operation='image_generation'|'image_edit'` distinct from
 * the enclosing request row (which the outer respond path records without an
 * `operation`).
 *
 * durationMs is measured from `attempt.upstreamCallStartedAt` (stamped by
 * `stampUpstreamCallStart`) to now. When the attempt never dialed (candidate
 * resolution failed), the caller must not invoke this helper — no upstream =
 * no perf row, matching the reference behavior.
 *
 * source/target api are pinned to 'responses' because this helper only fires
 * from the Responses image_generation shim; if a future consumer needs a
 * different pair, promote them to parameters.
 */
export async function recordImagePerformance(args: {
  apiKeyId: string
  attempt: AttemptState
  model: string
  upstream: string | null
  runtimeLocation: 'bun' | 'cloudflare'
  operation: PerformanceOperation
  failed: boolean
  repo?: Repo
  sourceApi?: PerformanceSourceApi
  targetApi?: PerformanceTargetApi
}): Promise<void> {
  const start = args.attempt.upstreamCallStartedAt
  if (start === null) return
  const durationMs = Math.max(0, performance.now() - start)
  const repo = args.repo ?? getRepo()
  const row: PerformanceRecordInput = {
    hour: currentHour(),
    metricScope: 'request_total',
    keyId: args.apiKeyId,
    model: args.model,
    upstream: args.upstream,
    sourceApi: args.sourceApi ?? 'responses',
    targetApi: args.targetApi ?? 'responses',
    stream: false,
    runtimeLocation: args.runtimeLocation,
    operation: args.operation,
    durationMs,
    isError: args.failed,
  }
  await repo.performance.record(row)
}
