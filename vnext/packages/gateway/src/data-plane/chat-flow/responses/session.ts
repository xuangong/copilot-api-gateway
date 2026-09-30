import { withBackground, type BackgroundExecutor } from "@vibe-core/platform"
import { extractHeaderCredential, resolveCredential, type FullAuthCtx } from "../../../shared/credential-auth.ts"
import { getDataPlaneConfiguration, withFreshConfigurationSnapshot } from "../../../repo/index.ts"
import { ConfigurationUnavailableError } from "../../../repo/configuration-cache.ts"
import { withRequestSignal } from "../../../shared/request-signal.ts"
import { openTransportDump } from "../../../shared/dump/accumulator.ts"
import { startResponsesTurn } from "./serve.ts"
import type { ResponsesTurn } from "./turn.ts"
import { ResponsesLocalContinuation } from "./local-continuation.ts"
import { parseResponsesSessionMessage, ResponsesSessionError, responsesSessionErrorEvent, type ResponsesSessionMessage } from "./session-protocol.ts"
import {
  RESPONSES_WS_CLEANUP_TIMEOUT_MS, RESPONSES_WS_DRAIN_TIMEOUT_MS, RESPONSES_WS_MAX_CONTROL_BYTES,
  RESPONSES_WS_MAX_LOCAL_STATE_BYTES, RESPONSES_WS_MAX_OUTBOUND_FRAME_BYTES, RESPONSES_WS_MAX_TURN_EVENT_BYTES,
  RESPONSES_WS_SEND_HIGH_WATER_BYTES, RESPONSES_WS_UNOBSERVABLE_LIFETIME_BYTES, utf8Bytes,
} from "./session-limits.ts"

export { ResponsesSessionError } from "./session-protocol.ts"
export type ResponsesSessionState = "idle" | "running" | "closing" | "closed"
export interface ResponsesSessionAuthorization {
  readonly credential: string
  readonly identity: Pick<FullAuthCtx, "userId" | "apiKeyId" | "authKind">
}
export interface ResponsesSessionTransport {
  readonly pressure: { kind: "observable"; bufferedBytes(): number } | { kind: "unobservable" }
  /** Acceptance by the native runtime, never a peer acknowledgement. */
  sendText(text: string): "accepted" | "backpressured" | "failed"
  close(code: number, reason: string): void
}
export interface ResponsesSessionClock {
  now(): number
  schedule(callback: () => void, milliseconds: number): () => void
}
const clockDefault: ResponsesSessionClock = {
  now: () => Date.now(),
  schedule(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer) },
}
export interface ResponsesSession {
  readonly state: ResponsesSessionState
  receiveText(text: string): void
  receiveBinary(): void
  drain(): void
  close(reason?: unknown): Promise<{ cleanupComplete: boolean }>
}

const invalidAuth = () => new ResponsesSessionError(401, "invalid_api_key", "Invalid API key or session.", 1008)
export async function authorizeResponsesSession(request: Request): Promise<ResponsesSessionAuthorization> {
  const url = new URL(request.url)
  if (["key", "api_key", "apiKey", "access_token", "token", "authorization"].some(name => url.searchParams.has(name))) {
    throw new ResponsesSessionError(400, "unsupported_credentials", "WebSocket credentials must use request headers.")
  }
  const credential = extractHeaderCredential(request.headers)
  if (!credential) throw invalidAuth()
  return withFreshConfigurationSnapshot(async () => {
    const auth = await resolveCredential(credential, { requireEnabledOwner: true })
    if (!auth?.userId && !auth?.apiKeyId) throw invalidAuth()
    return { credential, identity: { userId: auth.userId, apiKeyId: auth.apiKeyId, authKind: auth.authKind } }
  })
}

interface Job {
  readonly controller: AbortController
  readonly done: Promise<void>
  readonly resolve: () => void
  turn?: ResponsesTurn
  cleanupComplete: boolean
}

export function createResponsesSession(options: {
  readonly authorization: ResponsesSessionAuthorization
  readonly request: { readonly url: string; readonly headers: Headers }
  readonly transport: ResponsesSessionTransport
  readonly background: BackgroundExecutor
  readonly clock?: ResponsesSessionClock
}): ResponsesSession {
  const { transport, background } = options
  const clock = options.clock ?? clockDefault
  const identity = { ...options.authorization.identity }
  const credential = options.authorization.credential
  const headers = new Headers(options.request.headers)
  const path = new URL(options.request.url).pathname
  const local = new ResponsesLocalContinuation(clock.now)
  let state: ResponsesSessionState = "idle"
  let active: Job | undefined
  let settling: Job | undefined
  let closing: Promise<{ cleanupComplete: boolean }> | undefined
  let lifetimeBytes = 0
  let controlBytes = 0
  let backpressured = false
  let wakeDrain: (() => void) | undefined

  function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
    return new Promise(resolve => {
      const cancel = clock.schedule(() => resolve(undefined), milliseconds)
      void promise.then(value => { cancel(); resolve(value) }, () => { cancel(); resolve(undefined) })
    })
  }

  function close(reason?: unknown): Promise<{ cleanupComplete: boolean }> {
    if (closing) return closing
    const closed = Promise.withResolvers<{ cleanupComplete: boolean }>()
    closing = closed.promise
    state = "closing"
    local.clear()
    const jobs = [...new Set([active, settling].filter((job): job is Job => job !== undefined))]
    for (const job of jobs) { job.controller.abort(reason); job.turn?.abortController.abort(reason) }
    wakeDrain?.()
    try { transport.close(reason instanceof ResponsesSessionError ? reason.closeCode ?? 1011 : 1000, "Response session closed.") } catch { /* A failed native close is already disconnected. */ }
    void timeout(Promise.all(jobs.map(job => job.done)).then(() => jobs.every(job => job.cleanupComplete)), RESPONSES_WS_CLEANUP_TIMEOUT_MS)
      .then(cleanupComplete => { state = "closed"; closed.resolve({ cleanupComplete: cleanupComplete === true }) })
    return closing
  }

  function sizeFailure(): ResponsesSessionError { return new ResponsesSessionError(413, "output_limit", "Response output exceeds the session byte limit.", 1009) }
  function bufferedBytes(): number {
    if (transport.pressure.kind !== "observable") throw new Error("Buffer introspection is unavailable.")
    const value = transport.pressure.bufferedBytes()
    if (!Number.isFinite(value) || value < 0) throw new ResponsesSessionError(502, "send_failed", "Socket buffer state is unavailable.", 1011)
    return value
  }
  function checkSend(bytes: number): void {
    if (bytes > RESPONSES_WS_MAX_OUTBOUND_FRAME_BYTES) throw sizeFailure()
    if (transport.pressure.kind === "unobservable" && lifetimeBytes + bytes > RESPONSES_WS_UNOBSERVABLE_LIFETIME_BYTES) throw sizeFailure()
  }
  function nativeSend(text: string, bytes: number): void {
    checkSend(bytes)
    // Control replies can be accepted while a turn awaits capacity. Recheck
    // at the synchronous native boundary before adding another frame.
    if (transport.pressure.kind === "observable" && (backpressured || bufferedBytes() + bytes > RESPONSES_WS_SEND_HIGH_WATER_BYTES)) {
      throw new ResponsesSessionError(503, "backpressure_limit", "Socket send buffer limit exceeded.", 1008)
    }
    let accepted: ReturnType<ResponsesSessionTransport["sendText"]>
    try { accepted = transport.sendText(text) } catch { accepted = "failed" }
    if (accepted === "failed") throw new ResponsesSessionError(502, "send_failed", "Socket send failed.", 1011)
    lifetimeBytes += bytes
    if (accepted === "backpressured") backpressured = true
  }

  async function capacity(bytes: number, signal: AbortSignal): Promise<void> {
    checkSend(bytes)
    if (transport.pressure.kind === "unobservable") { signal.throwIfAborted(); return }
    const deadline = clock.now() + RESPONSES_WS_DRAIN_TIMEOUT_MS
    while (backpressured || bufferedBytes() + bytes > RESPONSES_WS_SEND_HIGH_WATER_BYTES) {
      signal.throwIfAborted()
      const remaining = deadline - clock.now()
      if (remaining <= 0) throw new ResponsesSessionError(503, "backpressure_timeout", "Socket backpressure deadline exceeded.", 1008)
      const ready = Promise.withResolvers<boolean>()
      const wake = () => ready.resolve(true)
      wakeDrain = wake
      signal.addEventListener("abort", wake, { once: true })
      try {
        if (await timeout(ready.promise, remaining) === undefined) throw new ResponsesSessionError(503, "backpressure_timeout", "Socket backpressure deadline exceeded.", 1008)
      } finally {
        signal.removeEventListener("abort", wake)
        if (wakeDrain === wake) wakeDrain = undefined
      }
    }
    signal.throwIfAborted()
  }

  function control(event: Record<string, unknown>): void {
    if (state === "closing" || state === "closed") return
    try {
      const text = JSON.stringify(event)
      const bytes = utf8Bytes(text)
      if (controlBytes + bytes > RESPONSES_WS_MAX_CONTROL_BYTES) throw sizeFailure()
      if (transport.pressure.kind === "observable" && (backpressured || bufferedBytes() + bytes > RESPONSES_WS_SEND_HIGH_WATER_BYTES)) {
        throw new ResponsesSessionError(503, "backpressure_timeout", "Socket cannot accept a protocol error.", 1008)
      }
      nativeSend(text, bytes)
      controlBytes += bytes
    } catch (error) { void close(error) }
  }

  async function run(job: Job, previous: Job | undefined, message: ResponsesSessionMessage, text: string): Promise<void> {
    try {
      if (previous) {
        const finished = await timeout(previous.done.then(() => previous.cleanupComplete), RESPONSES_WS_CLEANUP_TIMEOUT_MS)
        if (finished !== true) throw new ResponsesSessionError(503, "cleanup_timeout", "Previous response cleanup did not finish.", 1011)
      }
      job.controller.signal.throwIfAborted()
      // Do not start another inference while the prior accepted send is blocked.
      await capacity(0, job.controller.signal)
      await withFreshConfigurationSnapshot(async () => {
        job.controller.signal.throwIfAborted()
        const auth = await resolveCredential(credential, { requireEnabledOwner: true })
        if (!auth || (!auth.userId && !auth.apiKeyId)) throw invalidAuth()
        if (auth.userId !== identity.userId || auth.apiKeyId !== identity.apiKeyId || auth.authKind !== identity.authKind) throw invalidAuth()
        job.controller.signal.throwIfAborted()
        const apiKey = auth.apiKeyId ? await getDataPlaneConfiguration().apiKeys.getById(auth.apiKeyId) : null
        const dump = apiKey ? openTransportDump({ method: "WS", path, headers }, apiKey, { bytes: new TextEncoder().encode(text), streamError: null }, background) : null
        let sourceJson: string | undefined
        let compactTriggered = false
        const turn = startResponsesTurn({
          raw: message.raw, auth, warmup: message.warmup, localContinuation: local,
          retainInputHistory: false,
          signal: job.controller.signal, dump,
          obsCtx: { apiKeyId: auth.apiKeyId, userAgent: headers.get("user-agent") ?? undefined, requestId: crypto.randomUUID() },
          userAgent: headers.get("user-agent") ?? undefined,
          onPrepared(payload, compact) {
            compactTriggered = compact
            const json = JSON.stringify(payload)
            sourceJson = utf8Bytes(json) <= RESPONSES_WS_MAX_LOCAL_STATE_BYTES ? json : undefined
            if (message.warmup && (!sourceJson || !local.candidate(`resp_${"0".repeat(32)}`, payload, [], compact))) {
              throw new ResponsesSessionError(413, "local_state_limit", "Warmup exceeds the connection-local state limit.")
            }
          },
        })
        job.turn = turn
        if (job.controller.signal.aborted) turn.abortController.abort()
        const ready = await turn.ready
        let turnBytes = 0
        let delivered = false
        let candidate: string | undefined
        let completedId: string | undefined
        let created: Record<string, unknown> | undefined
        for await (const original of turn.events) {
          job.controller.signal.throwIfAborted()
          let event: Record<string, unknown> = original as unknown as Record<string, unknown>
          if (event.type === "response.created" && event.response && typeof event.response === "object") created = event.response as Record<string, unknown>
          if (event.type === "error") {
            const error = event.error && typeof event.error === "object" ? event.error as Record<string, unknown>
              : { type: "api_error", code: "response_failed", message: typeof event.message === "string" ? event.message : "Response failed." }
            event = ready.status < 400 && created
              ? { type: "response.failed", response: { ...created, status: "failed", output: [], error } }
              : { type: "error", status: ready.status >= 400 ? ready.status : 502, error }
          }
          const serialized = JSON.stringify(event)
          const bytes = utf8Bytes(serialized)
          if (turnBytes + bytes > RESPONSES_WS_MAX_TURN_EVENT_BYTES) throw sizeFailure()
          await capacity(bytes, job.controller.signal)
          nativeSend(serialized, bytes)
          turn.recordSentPayloadBytes(bytes)
          turnBytes += bytes
          job.controller.signal.throwIfAborted()
          if (event.type === "response.completed") {
            const response = event.response as { id?: unknown; output?: unknown }
            if (typeof response.id === "string" && Array.isArray(response.output)) {
              completedId = response.id
              candidate = sourceJson ? local.candidate(response.id, JSON.parse(sourceJson) as Record<string, unknown>, response.output, compactTriggered) : undefined
            }
            delivered = true
            // Native acceptance precedes publication; the next admitted job
            // waits this exact completion before resolving local state.
            settling = job
            if (active === job) { active = undefined; if (state === "running") state = "idle" }
          }
        }
        const completion = await turn.completion
        job.cleanupComplete = completion.cleanupComplete
        if (delivered && completedId && completion.outcome === "completed" && completion.cleanupComplete && !job.controller.signal.aborted) {
          local.publish(completedId, candidate)
        } else local.clear()
        if (!completion.cleanupComplete) throw new ResponsesSessionError(503, "cleanup_incomplete", "Response cleanup did not finish.", 1011)
      })
    } catch (error) {
      local.clear()
      job.turn?.abortController.abort(error)
      if (!job.controller.signal.aborted) {
        const problem = error instanceof ResponsesSessionError ? error
          : error instanceof ConfigurationUnavailableError ? new ResponsesSessionError(503, "configuration_unavailable", "Gateway configuration temporarily unavailable.")
          : new ResponsesSessionError(502, "response_failed", "Response processing failed.", 1011)
        if (!job.turn) control(responsesSessionErrorEvent(problem))
        if (problem.closeCode || job.turn) void close(problem)
      }
    } finally {
      if (job.turn) {
        const completion = await timeout(job.turn.completion, RESPONSES_WS_CLEANUP_TIMEOUT_MS)
        job.cleanupComplete = completion?.cleanupComplete === true
      }
      if (active === job) { active = undefined; if (state === "running") state = "idle" }
      if (settling === job) settling = undefined
      job.resolve()
    }
  }

  return {
    get state() { return state },
    receiveText(text) {
      if (state === "closing" || state === "closed") return
      let message: ResponsesSessionMessage
      try { message = parseResponsesSessionMessage(text) }
      catch (error) {
        const problem = error instanceof ResponsesSessionError ? error : new ResponsesSessionError(400, "invalid_request", "Invalid response message.")
        control(responsesSessionErrorEvent(problem))
        if (problem.closeCode) void close(problem)
        return
      }
      if (active) { control(responsesSessionErrorEvent(new ResponsesSessionError(409, "response_in_progress", "A response is already in progress."))); return }
      const completion = Promise.withResolvers<void>()
      const job: Job = { controller: new AbortController(), done: completion.promise, resolve: () => completion.resolve(), cleanupComplete: true }
      const previous = settling
      active = job
      state = "running"
      background.waitUntil(job.done)
      void withBackground(background, () => withRequestSignal(job.controller.signal, () => run(job, previous, message, text)))
    },
    receiveBinary() {
      const problem = new ResponsesSessionError(400, "unsupported_frame", "Only JSON text messages are supported.", 1003)
      control(responsesSessionErrorEvent(problem))
      void close(problem)
    },
    drain() { backpressured = false; wakeDrain?.() },
    close,
  }
}
