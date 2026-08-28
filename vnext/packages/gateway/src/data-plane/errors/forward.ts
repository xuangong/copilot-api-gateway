// vnext/packages/gateway/src/data-plane/errors/forward.ts
/**
 * Forward an upstream non-2xx Response to the client.
 *
 * This used to *repackage* the body: parse it, lift `error.message` out, and
 * re-mint an envelope in the inbound protocol's shape. That lost information
 * every time. Copilot's rejection of an unsupported tool, for instance, is
 *
 *     {"error":{"message":"The requested tool computer_use_preview is not
 *      supported.","code":"unsupported_value","param":"tools",
 *      "type":"invalid_request_error"}}
 *
 * served *without* a JSON content-type, so the old code took its non-JSON
 * branch and stuffed the entire raw text into `message` — double-encoded, with
 * `code` and `param` dropped (the extracted shape had no `param` field at all).
 * Clients that read those fields saw nothing.
 *
 * So this now matches `copilot-gateway`, which forwards the upstream body
 * byte-for-byte (`apiErrorToResponse`, packages/provider/src/result.ts). Two
 * details of that design are worth spelling out, because neither is obvious:
 *
 *   1. **Gemini is the exception.** The reference passes a Gemini error through
 *      only when the body already *is* a Google RPC error, and otherwise mints
 *      one (`googleRpcErrorPassthroughResponse(...) ?? geminiErrorResponse(...)`).
 *      That matters here more than there: no upstream we bind speaks Gemini
 *      natively, so a `/v1beta` request always crosses protocols and the error
 *      coming back is OpenAI-shaped. Forwarding it verbatim would hand a
 *      `@google/genai` client an envelope with no `code` and no `status`.
 *      The other three protocols nest their message identically
 *      (`error.message`), so their SDKs read a foreign body fine.
 *
 *   2. **Headers are forwarded, minus the ones that would lie.** `fetch`
 *      decompresses the body but leaves `content-encoding` and `content-length`
 *      on the response, so copying headers wholesale — as the reference does —
 *      hands the client a `gzip` label wrapped around plain text. Verified: a
 *      55-byte JSON body gzipped to 72 bytes arrives with both headers intact
 *      and an already-decoded `arrayBuffer()`. Those are stripped, along with
 *      the other hop-by-hop headers and `set-cookie`. Everything else survives,
 *      which is a small bonus: `retry-after` now reaches the client on a 429.
 */
import type { PreviousResponseNotFoundError } from '../dispatch/responses-store-bridge.ts'

export type SourceApi = 'messages' | 'chat_completions' | 'responses' | 'gemini' | undefined

/**
 * Headers that describe the *transfer* rather than the payload. They belong to
 * the hop we just terminated and are actively wrong on the hop we are opening.
 * `set-cookie` is not hop-by-hop but has no business crossing a proxy boundary.
 */
const NON_FORWARDABLE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
])

function forwardableHeaders(src: Headers): Headers {
  const out = new Headers()
  src.forEach((value, key) => {
    if (!NON_FORWARDABLE_HEADERS.has(key.toLowerCase())) out.append(key, value)
  })
  return out
}

/**
 * The Google RPC error body for a given HTTP status.
 *
 * Exported because upstream errors are not the only ones a `/v1beta` client
 * sees: the gemini route also mints its own (model-not-found, no-translator,
 * a reassembly failure). Those used to go out as a bare `{error:{message}}`,
 * i.e. the OpenAI shape this module exists to keep away from Gemini clients —
 * so the same request could answer in two different error shapes depending on
 * where it failed, and `@google/genai` found neither `code` nor `status` on
 * half of them.
 */
export function geminiErrorBody(status: number, message: string): { error: { code: number; message: string; status: string } } {
  return { error: { code: status, message, status: geminiStatus(status) } }
}

function geminiStatus(code: number): string {
  if (code === 400) return 'INVALID_ARGUMENT'
  if (code === 401) return 'UNAUTHENTICATED'
  if (code === 403) return 'PERMISSION_DENIED'
  if (code === 404) return 'NOT_FOUND'
  if (code === 429) return 'RESOURCE_EXHAUSTED'
  if (code >= 500) return 'INTERNAL'
  return 'UNKNOWN'
}

/**
 * Mirrors the reference's `isGeminiErrorResponse`. All three fields are
 * required: a bare `{error:{message}}` is what an OpenAI-shaped upstream sends,
 * and treating that as Google-shaped is exactly the confusion to avoid.
 */
function isGoogleRpcError(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const err = (parsed as { error?: unknown }).error
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown; status?: unknown }
  return typeof e.code === 'number' && typeof e.message === 'string' && typeof e.status === 'string'
}

/**
 * The fallback envelope, used only when there is nothing to forward (an empty
 * upstream body) or when forwarding would mislead (a non-Google body headed for
 * a Gemini client).
 */
function mintEnvelope(status: number, message: string, sourceApi: SourceApi): Response {
  const type = status >= 500 ? 'api_error' : 'invalid_request_error'
  let body: unknown
  if (sourceApi === 'messages') {
    body = { type: 'error', error: { type, message } }
  } else if (sourceApi === 'gemini') {
    body = geminiErrorBody(status, message)
  } else {
    body = { error: { type, message } }
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function forwardUpstreamError(res: Response, sourceApi: SourceApi): Promise<Response> {
  const bytes = new Uint8Array(await res.arrayBuffer())
  const status = res.status

  // Nothing to forward. A bodyless error tells the client only its status code,
  // so mint something with a message in it.
  if (bytes.byteLength === 0) return mintEnvelope(status, `upstream returned ${status}`, sourceApi)

  if (sourceApi === 'gemini') {
    const text = new TextDecoder().decode(bytes).trim()
    if (!isGoogleRpcError(text)) return mintEnvelope(status, text, 'gemini')
  }

  return new Response(bytes, { status, headers: forwardableHeaders(res.headers) })
}

/**
 * Render the responses snapshot miss as the OpenAI verbatim 400 envelope.
 * Kept separate from `forwardUpstreamError` because the "upstream" here is
 * gateway-side state (the snapshot store), not a remote 4xx body.
 */
export function renderPreviousResponseNotFound(err: PreviousResponseNotFoundError): Response {
  const body = {
    error: {
      message: err.message,
      type: 'invalid_request_error',
      param: 'previous_response_id',
      code: 'previous_response_not_found',
    },
  }
  return new Response(JSON.stringify(body), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
}
