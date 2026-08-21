/**
 * A request captured in a form that survives being sent more than once.
 *
 * The two-pass dial chain may attempt several transports for one logical call,
 * and a `BodyInit` is generally single-shot. `materialized()` buffers the body
 * into bytes once and hands every later attempt the same buffer; `fetchInit()`
 * keeps the original shape (FormData, Blob, …) intact for the direct-fetch-only
 * fast path, where the runtime's native body handling is preferable.
 *
 * Ported from copilot-gateway/packages/gateway/src/dial/replayable-request.ts.
 */
import type { HttpRequest } from '@vibe-core/http'
import { normalizeDialHost } from '@vibe-core/platform'
import type { ProxyRequestTarget } from '@vibe-core/proxy'

export interface MaterializedRequest {
  target: ProxyRequestTarget
  request: HttpRequest
}

export interface ReplayableRequest {
  readonly signal: AbortSignal | undefined
  fetchInit(): RequestInit
  materialized(): Promise<MaterializedRequest>
}

class ReplayableRequestOwner implements ReplayableRequest {
  readonly signal: AbortSignal | undefined
  private fetch: RequestInit
  private materializedRequest: MaterializedRequest | undefined
  private rebuildFetchBody = false

  constructor(
    private readonly url: string,
    init: RequestInit,
  ) {
    this.signal = init.signal ?? undefined
    this.fetch = init
  }

  fetchInit(): RequestInit {
    if (this.rebuildFetchBody) {
      this.fetch = rebuildInitFromMaterialized(this.fetch, this.materializedRequest!)
      this.rebuildFetchBody = false
    }
    return this.fetch
  }

  async materialized(): Promise<MaterializedRequest> {
    if (this.materializedRequest !== undefined) return this.materializedRequest
    this.materializedRequest = await buildMaterializedRequest(this.url, this.fetch)
    // Once bytes exist, the original BodyInit must not remain captured for the
    // duration of the upstream request. A later direct-fetch fallback rebuilds
    // its owned byte body lazily, so a successful proxy does not retain a
    // second full buffer merely because `direct_fetch` appears later.
    this.fetch = { ...this.fetch, body: null }
    this.rebuildFetchBody = true
    return this.materializedRequest
  }
}

export const createReplayableRequest = (url: string, init: RequestInit): ReplayableRequest =>
  new ReplayableRequestOwner(url, init)

const rebuildInitFromMaterialized = (
  original: RequestInit,
  materialized: MaterializedRequest,
): RequestInit => {
  const headers = new Headers(original.headers)
  const targetCt = materialized.request.headers['content-type']
  if (targetCt !== undefined && !headers.has('content-type')) {
    headers.set('content-type', targetCt)
  }
  // Copy into a freshly-allocated ArrayBuffer-backed Uint8Array so the BodyInit
  // slot accepts it under TypeScript's stricter typing — and so the buffer we
  // hand to runtime fetch never aliases one referenced elsewhere.
  let body: Uint8Array<ArrayBuffer> | null = null
  if (materialized.request.body) {
    const owned = new Uint8Array(materialized.request.body.byteLength)
    owned.set(materialized.request.body)
    body = owned
  }
  return { ...original, headers, body }
}

const buildMaterializedRequest = async (
  url: string,
  init: RequestInit,
): Promise<MaterializedRequest> => {
  const u = new URL(url)
  const collected = await collectBody(init.body)
  const headers = extractHeaders(init.headers)
  // FormData/URLSearchParams synthesize a Content-Type carrying the multipart
  // boundary or the urlencoded marker. Adopt it only when the caller did not
  // pre-set Content-Type itself, so explicit overrides keep winning.
  if (collected?.contentType !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = collected.contentType
  }
  // `URL#hostname` keeps the `[…]` envelope on IPv6 literals; the dial target
  // contract requires the bare address.
  const target: ProxyRequestTarget = {
    host: normalizeDialHost(u.hostname),
    port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
    tls: u.protocol === 'https:',
  }
  const request: HttpRequest = {
    method: init.method ?? 'GET',
    path: `${u.pathname}${u.search}`,
    headers,
    body: collected?.body,
  }
  return { target, request }
}

const extractHeaders = (input: RequestInit['headers'] | undefined): Record<string, string> => {
  if (!input) return {}
  const out: Record<string, string> = {}
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
    return out
  }
  if (Array.isArray(input)) {
    for (const pair of input) {
      const key = pair[0]
      if (key === undefined) continue
      out[key.toLowerCase()] = pair[1] ?? ''
    }
    return out
  }
  for (const [key, value] of Object.entries(input as Record<string, string>)) {
    out[key.toLowerCase()] = value
  }
  return out
}

interface CollectedBody {
  body: Uint8Array
  /** Content-Type the runtime synthesizes for FormData/URLSearchParams. */
  contentType?: string
}

const collectBody = async (
  body: RequestInit['body'] | undefined,
): Promise<CollectedBody | undefined> => {
  if (body == null) return undefined
  if (typeof body === 'string') return { body: new TextEncoder().encode(body) }
  if (body instanceof Uint8Array) return { body }
  if (body instanceof ArrayBuffer) return { body: new Uint8Array(body) }
  if (body instanceof Blob) return { body: new Uint8Array(await body.arrayBuffer()) }
  // FormData / URLSearchParams: round-trip through Request so the runtime
  // produces a canonical byte stream we can buffer alongside the synthesized
  // Content-Type (with boundary or charset).
  if (body instanceof FormData || body instanceof URLSearchParams) {
    const req = new Request('https://internal/', { method: 'POST', body })
    const buffer = new Uint8Array(await req.arrayBuffer())
    const contentType = req.headers.get('content-type') ?? synthesizeContentType(body, buffer)
    return { body: buffer, contentType }
  }
  throw new Error('unsupported BodyInit shape for materialized request')
}

/**
 * Bun leaves `Request.headers` empty for a FormData body even though it
 * serializes one with a boundary, so the Content-Type has to be recovered from
 * the bytes. Without it the buffered body travels with no Content-Type at all
 * and upstreams fall back to parsing multipart as JSON.
 */
const synthesizeContentType = (
  body: FormData | URLSearchParams,
  buffer: Uint8Array,
): string | undefined => {
  if (body instanceof URLSearchParams) return 'application/x-www-form-urlencoded;charset=UTF-8'
  // The first line of a multipart body is the delimiter: `--<boundary>`.
  const head = new TextDecoder().decode(buffer.subarray(0, 256))
  const eol = head.indexOf('\r\n')
  if (eol <= 2 || !head.startsWith('--')) return undefined
  return `multipart/form-data; boundary=${head.slice(2, eol)}`
}
