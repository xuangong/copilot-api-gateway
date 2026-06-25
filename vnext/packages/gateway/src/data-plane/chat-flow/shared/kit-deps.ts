// vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts
/**
 * Singleton ServeTemplateDeps for the LLM gateway's four chat-flow endpoints.
 *
 * The kit (@vibe-core/chat-flow-kit) is domain-neutral and takes its
 * env-touching collaborators by injection. This module is the SOLE
 * authoritative construction site — every endpoint wrapper imports the same
 * `kitDeps` value, so we never accidentally diverge on how the telemetry ctx
 * is shaped, how quota is enforced, or how 4xx envelopes are wrapped.
 *
 * `buildTelemetryCtx` mirrors what the four serves did inline before Spec 10:
 *   - apiKeyId falls back from obsCtx → auth.apiKeyId → '<unknown>' sentinel
 *     (anonymous test traffic);
 *   - requestId defaults to `crypto.randomUUID()` when the inbound header is
 *     absent (matches DispatchObsCtx tolerance);
 *   - userAgent stays nullable to match TelemetryRequestContext;
 *   - runtimeLocation is captured once via getRuntimeLocation() so persistence
 *     helpers tag rows with the right region/runtime.
 *
 * Reference: Spec 10 §3.2.
 */
import { getRuntimeLocation } from '@vibe-core/platform'
import type { KitAuthCtx, ServeTemplateDeps } from '@vibe-core/chat-flow-kit'
import { jsonErrorWrap } from './error-wrap.ts'
import { runQuotaGate } from './quota-gate.ts'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'

type AuthWithApiKey = KitAuthCtx & { readonly apiKeyId?: string | null }

export const kitDeps: ServeTemplateDeps<AuthWithApiKey, TelemetryRequestContext> = {
  runQuotaGate,
  jsonErrorWrap,
  buildTelemetryCtx: ({ auth, obsCtx, isStreaming, requestStartedAt }) => ({
    apiKeyId: (obsCtx.apiKeyId as string | null | undefined) ?? auth.apiKeyId ?? '<unknown>',
    userAgent: (obsCtx.userAgent as string | null | undefined) ?? null,
    requestId: (obsCtx.requestId as string | undefined) ?? crypto.randomUUID(),
    isStreaming,
    runtimeLocation: getRuntimeLocation(),
    requestStartedAt,
  }),
}
