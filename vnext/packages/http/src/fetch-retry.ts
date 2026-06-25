/**
 * fetchWithRetry — exponential backoff retry on 429/5xx, AbortController-based
 * timeout. Lifted verbatim from @vibe-llm/provider-copilot/src/lib/fetch-retry.ts
 * (which itself was lifted from apps/gateway/src/shared/lib/fetch-retry.ts).
 *
 * Behavior, retry curve, timeout semantics: unchanged.
 */
export interface FetchOptions extends RequestInit {
  maxRetries?: number
  retryDelay?: number
  timeout?: number
}

export async function fetchWithRetry(
  input: string | URL,
  init?: FetchOptions,
): Promise<Response> {
  const maxRetries = init?.maxRetries ?? 3
  const retryDelay = init?.retryDelay ?? 1000
  const timeout = init?.timeout

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let controller: AbortController | undefined
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      if (timeout) {
        controller = new AbortController()
        timeoutId = setTimeout(() => controller!.abort(), timeout)
      }

      const response = await fetch(input, {
        ...init,
        signal: controller?.signal ?? init?.signal,
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId)
      })

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return response
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt === maxRetries) {
          console.log(`[fetch] Failed after ${attempt + 1} attempts: HTTP ${response.status}`)
          return response
        }
        const delay = Math.min(retryDelay * Math.pow(2, attempt), 10000)
        console.log(`[fetch] Attempt ${attempt + 1} got HTTP ${response.status}, retrying in ${delay}ms...`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }

      return response
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "AbortError"
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
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  throw new Error("Max retries exceeded")
}
