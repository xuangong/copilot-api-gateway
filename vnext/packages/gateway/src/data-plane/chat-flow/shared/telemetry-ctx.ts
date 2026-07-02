/**
 * Telemetry-only request context, distinct from `@vibe-llm/protocols/common`'s
 * minimal `RequestContext`. Built once per request in serve.ts and threaded
 * through attempt + respond so persistence helpers (`recordUsage`,
 * `recordPerformance`) can write usage rows without touching `RequestContext`.
 */
import type { RuntimeLocation } from '@vibe-core/platform'
import type { PerformanceSourceApi } from '../../../shared/repo/types.ts'

export interface TelemetryRequestContext {
  readonly apiKeyId: string
  /** Matches legacy DispatchObsCtx — null when the inbound `User-Agent` header is absent. */
  readonly userAgent: string | null
  readonly requestId: string
  readonly isStreaming: boolean
  readonly runtimeLocation: RuntimeLocation
  readonly requestStartedAt: number
  /**
   * Inbound endpoint family this request entered through. Threaded into
   * `recordPerformance` so `performance_summary.source_api` reflects the
   * actual endpoint (messages / responses / chat-completions / gemini)
   * instead of the placeholder 'chat-completions'. Built from the kit's
   * `endpointTag` in `kit-deps.buildTelemetryCtx`. Optional so test stubs
   * (and the legacy callers that haven't been wired yet) can omit it; when
   * absent we fall back to 'chat-completions'.
   */
  readonly sourceApi?: PerformanceSourceApi
}
