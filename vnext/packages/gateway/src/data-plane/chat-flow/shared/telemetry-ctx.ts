/**
 * Telemetry-only request context, distinct from `@vnext/protocols/common`'s
 * minimal `RequestContext`. Built once per request in serve.ts and threaded
 * through attempt + respond so persistence helpers (`recordUsage`,
 * `recordPerformance`) can write usage rows without touching `RequestContext`.
 */
import type { RuntimeLocation } from '@vnext-gateway/platform'

export interface TelemetryRequestContext {
  readonly apiKeyId: string
  /** Matches legacy DispatchObsCtx — null when the inbound `User-Agent` header is absent. */
  readonly userAgent: string | null
  readonly requestId: string
  readonly isStreaming: boolean
  readonly runtimeLocation: RuntimeLocation
  readonly requestStartedAt: number
}
