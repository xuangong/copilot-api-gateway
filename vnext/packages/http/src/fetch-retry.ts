/** Exponential backoff on 429/5xx with per-attempt timeout and caller cancellation. */
// Matches `Fetcher` in @vibe-core/upstream exactly, so the gateway's
// fallback-aware fetcher can be injected here without a cast. `url` is a
// string (not string | URL) because that is what every implementation of it
// accepts; fetchWithRetry normalises before calling.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface FetchOptions extends RequestInit {
  maxRetries?: number
  retryDelay?: number
  timeout?: number
  // Named `fetchImpl`, not `fetcher`: Cloudflare's RequestInit already declares
  // a `fetcher` field (a service binding), and this object used to be spread
  // straight into fetch(), so on Workers the runtime saw our retry helper where
  // it expected a binding.
  fetchImpl?: FetchLike
}

function waitForRetry(delay: number, signal?: AbortSignal | null, cleanup?: Promise<void>): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    let delayElapsed = false
    let cleanupFinished = cleanup === undefined
    const complete = () => {
      if (!delayElapsed || !cleanupFinished) return
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      delayElapsed = true
      complete()
    }, delay)
    signal?.addEventListener("abort", onAbort, { once: true })
    void cleanup?.then(
      () => { cleanupFinished = true; complete() },
      () => { cleanupFinished = true; complete() },
    )
  })
}

export async function fetchWithRetry(
  input: string | URL,
  init?: FetchOptions,
): Promise<Response> {
  const { maxRetries = 3, retryDelay = 1000, timeout, fetchImpl = fetch, ...requestInit } = init ?? {}
  const callerSignal = init?.signal

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (callerSignal?.aborted) throw callerSignal.reason
    const timeoutController = timeout ? new AbortController() : undefined
    const signal = timeoutController
      ? callerSignal ? AbortSignal.any([callerSignal, timeoutController.signal]) : timeoutController.signal
      : callerSignal
    const timeoutId = timeoutController
      ? setTimeout(() => timeoutController.abort(), timeout)
      : undefined
    try {
      const response = await fetchImpl(String(input), {
        ...requestInit,
        signal,
      }).finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
      })
      if (callerSignal?.aborted) {
        void response.body?.cancel().catch(() => {})
        throw callerSignal.reason
      }

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return response
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt === maxRetries) {
          console.log(`[fetch] Failed after ${attempt + 1} attempts: HTTP ${response.status}`)
          return response
        }
        const delay = Math.min(retryDelay * Math.pow(2, attempt), 10000)
        const cleanup = response.body?.cancel().catch(() => {})
        console.log(`[fetch] Attempt ${attempt + 1} got HTTP ${response.status}, retrying in ${delay}ms...`)
        await waitForRetry(delay, callerSignal, cleanup)
        continue
      }

      return response
    } catch (error) {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      if (callerSignal?.aborted) throw callerSignal.reason
      const isTimeout = timeoutController?.signal.aborted === true
      const errMsg = isTimeout ? `timeout after ${timeout}ms` : (error instanceof Error ? error.message : String(error))

      if (attempt === maxRetries) {
        console.log(`[fetch] Failed after ${attempt + 1} attempts: ${errMsg}`)
        if (isTimeout) {
          throw new Error(`Request timeout after ${timeout}ms (${maxRetries + 1} attempts)`)
        }
        throw error
      }

      const delay = Math.min(retryDelay * Math.pow(2, attempt), 10000)
      console.log(`[fetch] Attempt ${attempt + 1} failed (${errMsg}), retrying in ${delay}ms...`)
      await waitForRetry(delay, callerSignal)
    }
  }

  throw new Error("Max retries exceeded")
}
