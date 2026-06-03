/**
 * Retry `/responses` calls that fail with Copilot's cyber_policy block.
 *
 * Copilot (and some OpenAI-compatible Responses upstreams) intermittently
 * return a `cyber_policy` error code for requests that are not actually
 * policy-violating. Retrying up to MAX_RETRIES times resolves the false positive
 * in practice.
 *
 * The flag `retry-cyber-policy` must be enabled for the upstream (Copilot
 * enables it by default). When the flag is absent the wrapper is a no-op.
 *
 * A cyber_policy failure surfaces either as:
 *   - A 4xx HTTP error body:  { "error": { "code": "cyber_policy", ... } }
 *   - A streaming terminal event: response.failed with error.code === "cyber_policy"
 *
 * For non-streaming responses we detect it in the JSON body and retry the full
 * request. For streaming we let the first response through — if it terminates
 * with a cyber_policy failure frame we retry and stream the fresh attempt.
 *
 * Reference: copilot-gateway targets/responses/interceptors/retry-cyber-policy.ts
 */

const MAX_RETRIES = 10
const CYBER_POLICY_CODE = "cyber_policy"

const isCyberPolicyBody = (body: unknown): boolean => {
  if (!body || typeof body !== "object") return false
  const b = body as Record<string, unknown>
  const err = b.error as Record<string, unknown> | undefined
  if (err?.code === CYBER_POLICY_CODE) return true
  const resp = b.response as Record<string, unknown> | undefined
  const respErr = resp?.error as Record<string, unknown> | undefined
  return respErr?.code === CYBER_POLICY_CODE
}

const parseSseEvent = (line: string): unknown => {
  if (!line.startsWith("data:")) return undefined
  try {
    return JSON.parse(line.slice(5).trimStart())
  } catch {
    return undefined
  }
}

const isCyberPolicySseTerminal = (data: unknown): boolean => {
  if (!data || typeof data !== "object") return false
  const d = data as Record<string, unknown>
  // { type: "response.failed", response: { error: { code: "cyber_policy" } } }
  if (d.type === "response.failed") {
    const resp = d.response as Record<string, unknown> | undefined
    const err = resp?.error as Record<string, unknown> | undefined
    return err?.code === CYBER_POLICY_CODE
  }
  // Top-level error object in the SSE stream
  return isCyberPolicyBody(d)
}

/** Non-streaming: check if the JSON response is a cyber_policy failure. */
export const isCyberPolicyResponse = async (response: Response): Promise<{ hit: boolean; body: string }> => {
  const body = await response.text()
  try {
    const parsed = JSON.parse(body)
    return { hit: isCyberPolicyBody(parsed), body }
  } catch {
    return { hit: false, body }
  }
}

/**
 * Wrap a streaming Response body. If the stream terminates with a
 * cyber_policy event, call `retry()` and forward the new stream instead.
 * Transparent for non-cyber-policy failures and successful streams.
 */
export function wrapCyberPolicyRetryStream(
  body: ReadableStream<Uint8Array>,
  retry: () => Promise<ReadableStream<Uint8Array> | null>,
  attemptsRemaining: number,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader()
      const buffered: Uint8Array[] = []
      let cyberPolicyHit = false

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffered.push(value)
          buffer += decoder.decode(value, { stream: true })

          // Scan lines for terminal cyber_policy frame
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            const data = parseSseEvent(line)
            if (data && isCyberPolicySseTerminal(data)) {
              cyberPolicyHit = true
            }
          }
        }

        if (!cyberPolicyHit || attemptsRemaining <= 0) {
          // Forward the original buffered stream
          for (const chunk of buffered) controller.enqueue(chunk)
          controller.close()
          return
        }

        // Retry: discard buffered output, stream fresh response
        const freshBody = await retry()
        if (!freshBody) {
          for (const chunk of buffered) controller.enqueue(chunk)
          controller.close()
          return
        }

        const wrapped = wrapCyberPolicyRetryStream(freshBody, retry, attemptsRemaining - 1)
        const freshReader = wrapped.getReader()
        while (true) {
          const { done, value } = await freshReader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (e) {
        // On read error flush whatever we have and close
        if (buffered.length > 0 && !cyberPolicyHit) {
          for (const chunk of buffered) controller.enqueue(chunk)
        }
        controller.error(e)
      }
    },
  })
}

/**
 * High-level wrapper for the direct `/responses` streaming path.
 * `call` must return a Response. Retries up to MAX_RETRIES times on
 * cyber_policy hits. When the flag is absent returns the first response
 * unchanged.
 */
export async function withCyberPolicyRetry(
  enabledFlags: ReadonlySet<string>,
  call: () => Promise<Response>,
): Promise<Response> {
  if (!enabledFlags.has("retry-cyber-policy")) return call()

  const makeBody = async (): Promise<ReadableStream<Uint8Array> | null> => {
    try {
      const r = await call()
      return r.body
    } catch {
      return null
    }
  }

  // Try non-streaming detection first (handles 4xx error bodies)
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await call()
    if (response.ok || response.headers.get("content-type")?.includes("text/event-stream")) {
      // For streaming responses, wrap the body with retry logic
      if (response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
        const wrappedBody = wrapCyberPolicyRetryStream(response.body, makeBody, MAX_RETRIES - attempt)
        return new Response(wrappedBody, {
          status: response.status,
          headers: response.headers,
        })
      }
      return response
    }

    const { hit, body } = await isCyberPolicyResponse(response)
    if (!hit || attempt >= MAX_RETRIES) {
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      })
    }
    // Retry non-streaming cyber_policy error
  }

  return call()
}
