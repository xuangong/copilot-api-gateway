import { Buffer } from "node:buffer"
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

const textEncoder = new TextEncoder()
// Bun 1.3 undercounts lone surrogates and splits pairs in short encodeInto
// destinations. Probe once; affected runtimes keep the bounded JS path.
const nativeUtf8Exact = Buffer.byteLength("\ud800", "utf8") === 3
  && textEncoder.encodeInto("😀", new Uint8Array(3)).read === 0
const utf8ByteLength = nativeUtf8Exact
  ? (text: string): number => Buffer.byteLength(text, "utf8")
  : (text: string): number => {
    let total = 0
    for (let index = 0; index < text.length; index++) {
      const point = text.codePointAt(index) ?? 0xfffd
      if (point > 0xffff) { total += 4; index++ }
      else total += point < 0x80 ? 1 : point < 0x800 ? 2 : 3
    }
    return total
  }

function encodePrefixCompat(text: string, prefix: Uint8Array): void {
  let copied = 0
  const write = (value: number) => { if (copied < prefix.byteLength) prefix[copied++] = value }
  for (let index = 0; index < text.length && copied < prefix.byteLength; index++) {
    let point = text.codePointAt(index) ?? 0xfffd
    if (point > 0xffff) index++
    else if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd
    if (point < 0x80) write(point)
    else if (point < 0x800) {
      write(0xc0 | (point >> 6))
      write(0x80 | (point & 0x3f))
    } else if (point < 0x10000) {
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
}

/** Counts the whole string while materializing only a bounded exact byte prefix. */
export function boundedUtf8(text: string, limit: number): { prefix: Uint8Array; totalBytes: number } {
  // Native counting does not materialize an encoded copy of the whole input.
  const totalBytes = utf8ByteLength(text)
  const prefix = new Uint8Array(Math.min(limit, totalBytes))
  if (!nativeUtf8Exact) { encodePrefixCompat(text, prefix); return { prefix, totalBytes } }
  const { read, written } = textEncoder.encodeInto(text, prefix)
  if (written < prefix.byteLength) {
    // encodeInto stops before an incomplete codepoint. Capture its leading
    // bytes too; two UTF-16 units cover a pair or the replacement of a lone half.
    const tail = textEncoder.encode(text.slice(read, read + 2))
    prefix.set(tail.subarray(0, prefix.byteLength - written), written)
  }
  return { prefix, totalBytes }
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
