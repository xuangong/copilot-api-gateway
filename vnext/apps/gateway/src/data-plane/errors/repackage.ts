/**
 * Repackage an upstream non-2xx Response into the inbound client protocol's
 * error envelope. Plan 1 (Task #29) — stays small on purpose; the protocol-
 * specific orchestrator error rendering belongs to a later interceptor layer.
 *
 * Behavior:
 *   - Status code is preserved verbatim.
 *   - The upstream body is parsed as JSON; we lift error.message / message
 *     out if present, otherwise stringify the entire body. Non-JSON bodies
 *     fall through to the raw text.
 *   - The envelope shape matches what the client SDK expects so users see
 *     a coherent error instead of an upstream-shaped object.
 */
export type SourceApi = 'messages' | 'chat_completions' | 'responses' | 'gemini' | undefined

interface ExtractedError {
  message: string
  type?: string
  code?: string
}

async function extractUpstream(res: Response): Promise<ExtractedError> {
  const text = await res.text()
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const p = parsed as { error?: { message?: string; type?: string; code?: string }; message?: string }
        const e = p.error
        if (e && typeof e.message === 'string') return { message: e.message, type: e.type, code: e.code }
        if (typeof p.message === 'string') return { message: p.message }
      }
      return { message: text }
    } catch {
      return { message: text }
    }
  }
  return { message: text || `upstream returned ${res.status}` }
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

export async function repackageUpstreamError(res: Response, sourceApi: SourceApi): Promise<Response> {
  const { message, type, code } = await extractUpstream(res)
  const status = res.status
  let body: unknown
  if (sourceApi === 'messages') {
    body = {
      type: 'error',
      error: { type: type ?? (status >= 500 ? 'api_error' : 'invalid_request_error'), message },
    }
  } else if (sourceApi === 'chat_completions' || sourceApi === 'responses') {
    body = {
      error: {
        type: type ?? (status >= 500 ? 'api_error' : 'invalid_request_error'),
        message,
        ...(code !== undefined ? { code } : {}),
      },
    }
  } else if (sourceApi === 'gemini') {
    body = {
      error: { code: status, message, status: geminiStatus(status) },
    }
  } else {
    body = { error: { message, ...(code !== undefined ? { code } : {}) } }
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
