import { withCanonicalCompletion } from "@vibe-core/chat-flow-kit"
import type { TelemetryModelIdentity } from "@vibe-llm/protocols/common"
import { finalModelIdentity, type SourceStreamState } from "./respond-telemetry"
import type { TelemetryRequestContext } from "./telemetry-ctx"
import type { DumpAccumulator } from "../../../shared/dump/accumulator"

export function canonicalCancellation(state: SourceStreamState, options: {
  dump?: DumpAccumulator | null
  telemetryCtx?: TelemetryRequestContext
  downstreamAbortController?: AbortController
}, identity: TelemetryModelIdentity, resolveModelIdentity?: (modelKey: string) => TelemetryModelIdentity | null): () => void {
  const { dump, telemetryCtx, downstreamAbortController } = options
  return () => {
    if (state.cancelled) return
    dump?.cancelled(finalModelIdentity(identity, state.modelKey, resolveModelIdentity), state.usage.tokens)
    state.cancel()
    telemetryCtx?.metrics?.finish("cancelled")
    downstreamAbortController?.abort()
  }
}

export function canonicalJsonResponse(body: unknown, settled: Promise<void>, status = 200, cancel?: () => void): Response {
  const json = JSON.stringify(body)
  const response = json === undefined ? Response.json(body, { status }) : new Response(json, {
    status, headers: { "content-type": "application/json" },
  })
  return withCanonicalCompletion(response, { settled, cancel, fallbackBody: json })
}
