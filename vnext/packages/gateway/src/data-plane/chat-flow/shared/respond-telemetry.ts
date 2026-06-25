/**
 * Centralised telemetry persistence for the data-plane chat-flow.
 *
 * `respond.ts` of every endpoint funnels its `LlmEventResult` through these
 * helpers exactly once, replacing the legacy `runConversationAttempt` triple
 * (quota → upstream → recordLatency).
 *
 * Wire format (must remain identical to legacy `usage-tracker.ts` /
 *  `latency-tracker.ts` so import/export and dashboards keep working):
 *   - `recordUsage` writes `Repo.usage.record(UsageRecord)` + bumps
 *     `apiKeys.touchLastUsed`. Skipped when all token dimensions are zero.
 *   - `recordPerformance` writes `Repo.performance.record(PerformanceRecordInput)`
 *     translating the spec §6.2 semantic `failed` flag into the legacy
 *     `isError` column. Always uses metricScope='request_total'.
 *
 * `SourceStreamState` is a stateful accumulator the legacy snapshot-sidecar
 * passes around; kept here so the chat-flow respond path can share the same
 * `applyStreamEvent` / `extractFromJson` plumbing.
 */
import type {
  LlmEventResult,
  EventResultMetadata,
  PerformanceTelemetryContext,
  TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
import { detectClient } from '../../../shared/observability/client-detect.ts'
import {
  applyStreamEvent,
  extractFromJson,
  type UsageInfo,
} from '../../../shared/observability/usage-extractor.ts'
import { getRepo } from '../../../shared/repo/index.ts'
import type {
  PerformanceRecordInput,
  Repo,
  TokenUsage,
  UsageRecord,
} from '../../../shared/repo/types.ts'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'

const __replacedFlag = '__interceptorReplaced'

/**
 * Resolve the metadata to persist. Prefers `finalMetadata` (interceptor-replaced
 * streams expose their own modelIdentity/performance after draining) over
 * `result.modelIdentity` + `result.performance` (pass-through).
 *
 * Drift detection: a normal pass-through respond path should NOT set
 * `finalMetadata`. We can't enforce by type; emit a `console.warn` so
 * accidental sets surface in dev logs.
 */
export async function eventResultMetadata<T>(
  result: LlmEventResult<T>,
): Promise<EventResultMetadata> {
  if (result.finalMetadata) {
    const md = await result.finalMetadata
    if (!(__replacedFlag in (result as object))) {
      console.warn(
        'eventResultMetadata: finalMetadata set without __interceptorReplaced provenance flag',
      )
    }
    return md
  }
  return { modelIdentity: result.modelIdentity, performance: result.performance }
}

/**
 * Stateful accumulator carried through `chat-flow/respond.ts` while a stream
 * drains. Exposes the same `applyStreamEvent` / `extractFromJson` plumbing
 * the legacy `usage-tracker` uses, so wire-format-bearing helpers see
 * identical token shapes.
 */
export class SourceStreamState {
  modelKey: string
  failed = false
  usage: UsageInfo

  constructor(initialModelKey: string) {
    this.modelKey = initialModelKey
    this.usage = { model: undefined, tokens: {} }
  }

  rememberUsage(parsedEvent: unknown): void {
    applyStreamEvent(parsedEvent, this.usage)
  }

  rememberUsageFromJson(json: unknown): void {
    const u = extractFromJson(json)
    if (u) this.usage = u
  }

  rememberModelKey(key: unknown): void {
    if (typeof key !== 'string') return
    if (key.length === 0) return
    if (key === this.modelKey) return
    this.modelKey = key
  }

  failedAfter(): void {
    this.failed = true
  }
}

function nonZeroUsage(tokens: TokenUsage): boolean {
  for (const k in tokens) {
    if ((tokens as Record<string, number | undefined>)[k]) return true
  }
  return false
}

function currentHour(): string {
  return new Date().toISOString().slice(0, 13)
}

/**
 * Persist a usage row keyed by `modelIdentity` + `telemetryCtx.apiKeyId`.
 * No-ops when usage is empty (spec §6.2 — failed paths write zero usage rows).
 * Also calls `repo.apiKeys.touchLastUsed` to mirror legacy dispatch behaviour.
 *
 * Wire format mirrors legacy `usage-tracker.ts.persistUsage`:
 *   `{keyId, model, modelKey, upstream, client, hour, requests:1, tokens, cost}`
 */
export async function recordUsage(
  telemetryCtx: TelemetryRequestContext,
  modelIdentity: TelemetryModelIdentity,
  tokens: TokenUsage,
  repo: Repo = getRepo(),
): Promise<void> {
  if (!nonZeroUsage(tokens)) return
  const row: UsageRecord = {
    keyId: telemetryCtx.apiKeyId,
    model: modelIdentity.model,
    modelKey: modelIdentity.modelKey,
    upstream: modelIdentity.upstream,
    client: detectClient(telemetryCtx.userAgent),
    hour: currentHour(),
    requests: 1,
    tokens,
    cost: modelIdentity.cost,
  }
  await Promise.all([
    repo.usage.record(row),
    repo.apiKeys.touchLastUsed(telemetryCtx.apiKeyId),
  ])
}

/**
 * Persist a performance row. No-op when `performance` is undefined (e.g.
 * `internal-error` raised before binding selection — model-not-found etc.).
 *
 * Wire format mirrors legacy `latency-tracker.ts.recordLatency`'s
 * performance fan-out (metricScope='request_total'). The semantic `failed`
 * flag is translated to the legacy `isError` column. `sourceApi` / `targetApi`
 * are intentionally placeholder strings here — Part 1 helpers don't yet know
 * which endpoint invoked them; subsequent parts will surface them through
 * `TelemetryRequestContext` once endpoint code starts wiring respond.ts.
 */
export async function recordPerformance(
  telemetryCtx: TelemetryRequestContext,
  performance: PerformanceTelemetryContext | undefined,
  failed: boolean,
  repo: Repo = getRepo(),
): Promise<void> {
  if (!performance) {
    console.debug(
      'recordPerformance: skipping (no performance context — pre-binding error)',
    )
    return
  }
  const durationMs = Date.now() - telemetryCtx.requestStartedAt
  const row: PerformanceRecordInput = {
    hour: currentHour(),
    metricScope: 'request_total',
    keyId: performance.keyId,
    model: performance.model,
    upstream: performance.upstream,
    // Placeholders until endpoint wiring lands in Parts 2/3/4.
    sourceApi: 'chat-completions',
    targetApi: 'chat-completions',
    stream: performance.stream,
    runtimeLocation: performance.runtimeLocation,
    durationMs,
    isError: failed,
  }
  await repo.performance.record(row)
}

export type { LlmEventResult }
