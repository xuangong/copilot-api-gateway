import type { DialAttemptInput, DialObserver } from "@vibe-core/dial"
import type { ProviderRequest } from "@vibe-llm/provider-llm"
import { UPSTREAM_ATTEMPT_LIMITS, type UpstreamAttemptCapture, type UpstreamExchangeCollector } from "./upstream-attempts.ts"

export { boundedUtf8 } from "./bounded-utf8.ts"

export type UpstreamOperation =
  | "chat.completions" | "responses.create" | "responses.compact" | "messages.create"
  | "count_tokens" | "embeddings.create" | "images.generate" | "images.edit" | "search"

interface OperationScope {
  upstreamId: string
  operation: UpstreamOperation
}

export function operationForProviderRequest(
  request: Pick<ProviderRequest, "endpoint" | "action">,
): UpstreamOperation | null {
  switch (request.endpoint) {
    case "chat_completions": return "chat.completions"
    case "responses": return request.action === "compact" ? "responses.compact" : "responses.create"
    case "messages": return "messages.create"
    case "messages_count_tokens": return "count_tokens"
    case "embeddings": return "embeddings.create"
    case "images_generations": return "images.generate"
    case "images_edits": return "images.edit"
    case "alpha_search": return "search"
    default: return null
  }
}

/** One context belongs to one retained logical request, including all providers and endpoints. */
export function createUpstreamDialObservationContext(collector: UpstreamExchangeCollector): {
  forOperation(scope: OperationScope): DialObserver
} {
  let nextCallId = 0
  return {
    forOperation: ({ upstreamId, operation }) => ({
      beginCall: () => {
        const parentCallId = `call_${++nextCallId}`
        return {
          beginAttempt(input: DialAttemptInput) {
            try {
              const capture = collector.begin({
                parentCallId,
                upstreamId,
                operation,
                method: input.method,
                startedAt: input.startedAt,
                requestHeaders: headerPairs(input.requestHeaders),
              })
              if (!capture) return undefined
              observePreparedBody(capture, input.body)
              return {
                onResponse(response: Response): Response {
                  try {
                    if (response.status === 0) return response
                    const body = capture.observeResponse(response.status, headerPairs(response.headers), response.body)
                    if (body === null) return response
                    const metadata = {
                      url: response.url,
                      redirected: response.redirected,
                      type: response.type,
                    }
                    const wrapped = new Response(body, {
                      status: response.status,
                      statusText: response.statusText,
                      headers: response.headers,
                    })
                    return preserveMetadata(wrapped, metadata)
                  } catch {
                    // The observer has not read or locked the source body.
                    return response
                  }
                },
                onFetchError(category: "network" | "abort" | "unknown"): void {
                  try { capture.fetchError(category) } catch { /* best effort */ }
                },
              }
            } catch {
              return undefined
            }
          },
        }
      },
    }),
  }
}

const headerPairs = (headers: DialAttemptInput["requestHeaders"] | Headers): Iterable<readonly [string, string]> => {
  if (!headers) return []
  if (headers instanceof Headers) return headers.entries()
  // The dial layer supplies its already normalized transport record here;
  // this adapter never walks the caller's original RequestInit for diagnostics.
  return (function* (): Generator<readonly [string, string]> {
    for (const key in headers) {
      if (Object.hasOwn(headers, key)) yield [key, headers[key] ?? ""]
    }
  })()
}

const observePreparedBody = (capture: UpstreamAttemptCapture, body: DialAttemptInput["body"]): void => {
  if (body.kind === "unobserved") return
  if (body.kind === "text") { capture.observePreparedText(body.text); return }
  if (body.kind === "empty") { capture.observePreparedText(""); return }
  capture.observePreparedRequest({
    prefix: body.bytes.subarray(0, UPSTREAM_ATTEMPT_LIMITS.requestPrefix),
    totalBytes: body.bytes.byteLength,
  })
}

const preserveMetadata = (
  response: Response,
  metadata: { url: string; redirected: boolean; type: ResponseType },
): Response => {
  Object.defineProperties(response, {
    url: { configurable: true, get: () => metadata.url },
    redirected: { configurable: true, get: () => metadata.redirected },
    type: { configurable: true, get: () => metadata.type },
    clone: {
      configurable: true,
      value: function (this: Response): Response {
        return preserveMetadata(Response.prototype.clone.call(this), metadata)
      },
    },
  })
  return response
}
