// packages/gateway/src/protection/observe.ts
import { HTTPError, type ProviderRequest, type ProviderResponse, type RetriedUpstreamAttempt } from "@vibe-llm/provider-llm"
import { classifyStatus, classifyThrown, extractErrorDetail, isSampledClass } from "./classify.ts"
import { getProtection, type ProtectionRuntime, type UpstreamOutcome } from "./runtime.ts"

export interface UpstreamIdentity { upstreamId: string; keyId: string; model: string }
type Recorder = Pick<ProtectionRuntime, "record">
type RuntimeAccessor = () => Recorder

const DETAIL_BYTES = 4096
const DETAIL_TIMEOUT_MS = 5000
const NO_DETAIL = { code: "", message: "" }

/** Identity of one upstream call. `keyId` is `''` when the request carries no API key. */
export const protectionIdentity = (telemetry: { apiKeyId?: string }, upstreamId: string, model: string): UpstreamIdentity =>
  ({ upstreamId, keyId: telemetry.apiKeyId ?? "", model })

const outcome = (identity: UpstreamIdentity, cls: UpstreamOutcome["cls"], status: number, detail: { code: string; message: string }): UpstreamOutcome =>
  ({ ...identity, cls, status, code: detail.code, message: detail.message })

/** At most 4 KiB of an error body, never longer than 5 s, always releasing the stream. */
async function readDetail(body: ReadableStream<Uint8Array> | null): Promise<{ code: string; message: string }> {
  if (!body) return NO_DETAIL
  const reader = body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const read = (async (): Promise<string> => {
      const chunks: Uint8Array[] = []
      let size = 0
      while (size < DETAIL_BYTES) {
        const next = await reader.read()
        if (next.done) break
        chunks.push(next.value)
        size += next.value.byteLength
      }
      const merged = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
      return new TextDecoder().decode(merged.subarray(0, DETAIL_BYTES))
    })()
    const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), DETAIL_TIMEOUT_MS) })
    const text = await Promise.race([read, timeout])
    return text === null ? NO_DETAIL : extractErrorDetail(text)
  } catch { return NO_DETAIL } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Never await this: cancelling one tee branch settles only when the other branch (the client's) finishes.
    void reader.cancel().catch(() => {})
  }
}

const safely = (work: () => void): void => { try { work() } catch { /* observation never changes the outcome */ } }

/** For `Response` objects (embeddings, images): records the status, reading a clone so the original stays readable. */
export function recordResponse(identity: UpstreamIdentity, response: Response, runtime: RuntimeAccessor = getProtection): void {
  safely(() => {
    const cls = classifyStatus(response.status)
    if (!isSampledClass(cls) || !response.body || response.bodyUsed) {
      runtime().record(outcome(identity, cls, response.status, NO_DETAIL))
      return
    }
    const pending = readDetail(response.clone().body).then(detail => outcome(identity, cls, response.status, detail))
    runtime().record(pending)
  })
}

/**
 * An `HTTPError` counts by its response status, unless it is a provider-built transport failure (synthetic 502:
 * `network`, named after the original error); other transport failures are `network`; aborts and gateway errors are ignored.
 */
export function recordThrown(identity: UpstreamIdentity, error: unknown, signal?: AbortSignal, runtime: RuntimeAccessor = getProtection): void {
  safely(() => {
    if (signal?.aborted) return
    if (error instanceof HTTPError) {
      if (!error.transport) { recordResponse(identity, error.response, runtime); return }
      const cause = error.cause
      runtime().record(outcome(identity, "network", 0, { code: "", message: cause instanceof Error ? cause.name : "Error" }))
      return
    }
    const cls = classifyThrown(error, signal)
    if (cls) runtime().record(outcome(identity, cls, 0, { code: "", message: error instanceof Error ? error.name : "Error" }))
  })
}

/** Counts of one upstream attempt that the provider retried or replaced: class only, no body is read. */
function recordRetried(identity: UpstreamIdentity, attempt: RetriedUpstreamAttempt, signal: AbortSignal | undefined, runtime: RuntimeAccessor): void {
  safely(() => {
    if (attempt.status !== undefined) {
      // A 401/403 the provider cured by refreshing the credential and replaying the request is not a risk: the caller never saw it.
      const cls = attempt.outcome === "replayed" && classifyStatus(attempt.status) === "auth" ? "other" : classifyStatus(attempt.status)
      runtime().record(outcome(identity, cls, attempt.status, NO_DETAIL))
    }
    else recordThrown(identity, attempt.error, signal, runtime)
  })
}

/** For `provider.fetch` calls made outside the chat flows (embeddings, images): the observer for `ProviderRequest.onRetriedAttempt`. */
export const retriedAttemptObserver = (identity: UpstreamIdentity, signal?: AbortSignal, runtime: RuntimeAccessor = getProtection) =>
  (attempt: RetriedUpstreamAttempt): void => recordRetried(identity, attempt, signal, runtime)

/**
 * Wraps one `provider.fetch`: every response and thrown failure of the call is recorded exactly once. A non-2xx body is
 * `tee()`d so the client path keeps one branch and the observer reads the other in the background.
 */
export function withUpstreamProtection(
  identity: UpstreamIdentity,
  fetch: (request: ProviderRequest) => Promise<ProviderResponse>,
  runtime: RuntimeAccessor = getProtection,
): (request: ProviderRequest) => Promise<ProviderResponse> {
  return async (request) => {
    let response: ProviderResponse
    try {
      response = await fetch({ ...request, onRetriedAttempt: retriedAttemptObserver(identity, request.signal ?? undefined, runtime) })
    } catch (error) {
      recordThrown(identity, error, request.signal ?? undefined, runtime)
      throw error
    }
    if (response.gatewayGenerated) return response // built by the provider, never sent upstream
    let result = response
    safely(() => {
      const cls = classifyStatus(response.status)
      if (!isSampledClass(cls) || !response.body) {
        runtime().record(outcome(identity, cls, response.status, NO_DETAIL))
        return
      }
      const [forClient, forObserver] = response.body.tee()
      result = { ...response, body: forClient }
      // Start reading before touching the runtime so the observer branch is always drained and released.
      const pending = readDetail(forObserver).then(detail => outcome(identity, cls, response.status, detail))
      runtime().record(pending)
    })
    return result
  }
}
