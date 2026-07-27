/**
 * Ported from copilot-gateway data-plane/chat/shared/external-image-loader.ts,
 * with two vNext-specific adjustments:
 *  1. Takes an injectable `fetch` (defaults to global) instead of pulling in a
 *     platform-level `getExternalResourceFetcher()` singleton — vNext has no
 *     such abstraction yet and image-generation is the only caller.
 *  2. Drops the `createExternalImageLoader` wrapper (a `RemoteImageLoader`
 *     adapter for the translate layer); nothing in vNext needs it yet.
 *
 * Fetches user-supplied image URLs for hosted image_generation. Enforces:
 *  - http:/https: only, no userinfo
 *  - ≤5 redirects, following Location on 30x
 *  - 30 s timeout, 50 MiB size cap
 *  - per-fetcher URL memoization (same URL cited twice in one turn → one fetch)
 *  - abort propagation from the request signal
 */

const MAX_REDIRECTS = 5
const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type ExternalImageFetchResult =
  | { type: 'success'; finalUrl: URL; status: number; mediaType: string | null; data: Uint8Array }
  | { type: 'invalid-url' }
  | { type: 'invalid-redirect'; status: number; reason: 'missing-location' | 'invalid-location' | 'too-many-redirects' }
  | { type: 'http-error'; status: number }
  | { type: 'too-large'; limitBytes: number }
  | { type: 'empty-body' }
  | { type: 'timeout' }
  | { type: 'transport-error'; error: unknown }

export type ExternalImageFetcher = (url: string) => Promise<ExternalImageFetchResult>

export interface ExternalImageFetcherOptions {
  readonly fetch?: typeof fetch
  readonly downstreamSignal?: AbortSignal
}

const parseExternalUrl = (value: string, base?: URL): URL | null => {
  try {
    const url = base === undefined ? new URL(value) : new URL(value, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username !== '' || url.password !== '') return null
    url.hash = ''
    return url
  } catch {
    return null
  }
}

const contentLengthExceedsLimit = (response: Response): boolean => {
  const raw = response.headers.get('content-length')
  if (raw === null) return false
  const value = Number(raw)
  return Number.isFinite(value) && value > MAX_IMAGE_BYTES
}

type BoundedBodyResult =
  | { type: 'success'; data: Uint8Array }
  | Extract<ExternalImageFetchResult, { type: 'too-large' | 'empty-body' }>

const readBoundedBody = async (response: Response): Promise<BoundedBodyResult> => {
  if (contentLengthExceedsLimit(response)) {
    await response.body?.cancel()
    return { type: 'too-large', limitBytes: MAX_IMAGE_BYTES }
  }
  if (response.body === null) return { type: 'empty-body' }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel()
        return { type: 'too-large', limitBytes: MAX_IMAGE_BYTES }
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) return { type: 'empty-body' }

  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { type: 'success', data }
}

const fetchExternalImage = async (
  initialUrl: URL,
  fetchImpl: typeof fetch,
  downstreamSignal?: AbortSignal,
): Promise<ExternalImageFetchResult> => {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const signal = downstreamSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([downstreamSignal, timeoutSignal])
  let url = initialUrl

  try {
    for (let redirectCount = 0; ; redirectCount++) {
      downstreamSignal?.throwIfAborted()
      const response = await fetchImpl(url, { signal, redirect: 'manual' })
      if (!REDIRECT_STATUSES.has(response.status)) {
        if (!response.ok) {
          await response.body?.cancel()
          return { type: 'http-error', status: response.status }
        }
        const body = await readBoundedBody(response)
        if (body.type !== 'success') return body
        return {
          type: 'success',
          finalUrl: url,
          status: response.status,
          mediaType: response.headers.get('content-type'),
          data: body.data,
        }
      }

      await response.body?.cancel()
      if (redirectCount >= MAX_REDIRECTS) {
        return { type: 'invalid-redirect', status: response.status, reason: 'too-many-redirects' }
      }
      const location = response.headers.get('location')
      if (location === null) return { type: 'invalid-redirect', status: response.status, reason: 'missing-location' }
      const redirected = parseExternalUrl(location, url)
      if (redirected === null) return { type: 'invalid-redirect', status: response.status, reason: 'invalid-location' }
      url = redirected
    }
  } catch (error) {
    downstreamSignal?.throwIfAborted()
    return timeoutSignal.aborted ? { type: 'timeout' } : { type: 'transport-error', error }
  }
}

export const createExternalImageFetcher = (options: ExternalImageFetcherOptions = {}): ExternalImageFetcher => {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const downstreamSignal = options.downstreamSignal
  const requests = new Map<string, Promise<ExternalImageFetchResult>>()
  return value => {
    downstreamSignal?.throwIfAborted()
    const url = parseExternalUrl(value)
    if (url === null) return Promise.resolve({ type: 'invalid-url' })
    const cached = requests.get(url.href)
    if (cached !== undefined) return cached
    const request = fetchExternalImage(url, fetchImpl, downstreamSignal)
    requests.set(url.href, request)
    return request
  }
}

export const EXTERNAL_IMAGE_MAX_BYTES = MAX_IMAGE_BYTES
