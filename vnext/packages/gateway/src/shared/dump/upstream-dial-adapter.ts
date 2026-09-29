import type { DialAttemptInput, DialObserver } from "@vibe-core/dial"
import type { ProviderRequest } from "@vibe-llm/provider-llm"
import { UPSTREAM_ATTEMPT_LIMITS, type UpstreamExchangeCollector } from "./upstream-attempts.ts"

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
              const prepared = preparedBody(input.body)
              if (prepared) capture.observePreparedRequest(prepared)
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

const preparedBody = (body: DialAttemptInput["body"]): { prefix: Uint8Array; totalBytes: number } | null => {
  if (body.kind === "unobserved") return null
  if (body.kind === "empty") return { prefix: new Uint8Array(0), totalBytes: 0 }
  if (body.kind === "bytes") {
    return {
      prefix: body.bytes.subarray(0, UPSTREAM_ATTEMPT_LIMITS.requestPrefix),
      totalBytes: body.bytes.byteLength,
    }
  }
  return boundedUtf8(body.text, UPSTREAM_ATTEMPT_LIMITS.requestPrefix)
}

/** Counts the whole string while materializing only a bounded exact byte prefix. */
export function boundedUtf8(text: string, limit: number): { prefix: Uint8Array; totalBytes: number } {
  const prefix = new Uint8Array(Math.min(limit, text.length * 3))
  let copied = 0
  let totalBytes = 0
  // Keep this outside the loop: keep-names builds define its name on each creation.
  const write = (value: number) => { if (copied < limit) prefix[copied++] = value }
  for (let i = 0; i < text.length; i++) {
    let point = text.codePointAt(i) ?? 0xfffd
    if (point > 0xffff) i++
    else if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd
    const bytes = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
    totalBytes += bytes
    if (copied >= limit) continue
    if (bytes === 1) write(point)
    else if (bytes === 2) {
      write(0xc0 | (point >> 6))
      write(0x80 | (point & 0x3f))
    } else if (bytes === 3) {
      write(0xe0 | (point >> 12))
      write(0x80 | ((point >> 6) & 0x3f))
      write(0x80 | (point & 0x3f))
    } else {
      write(0xf0 | (point >> 18))
      write(0x80 | ((point >> 12) & 0x3f))
      write(0x80 | ((point >> 6) & 0x3f))
      write(0x80 | (point & 0x3f))
    }
  }
  return { prefix: prefix.subarray(0, copied), totalBytes }
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
