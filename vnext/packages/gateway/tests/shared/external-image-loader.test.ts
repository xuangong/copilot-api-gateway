import { test, expect } from 'bun:test'
import { createExternalImageFetcher } from '../../src/data-plane/shared/external-image-loader.ts'

test('follows relative redirects and memoizes a single request chain', async () => {
  const requested: string[] = []
  const fakeFetch = (async (url: URL | string) => {
    const u = typeof url === 'string' ? new URL(url) : url
    requested.push(u.href)
    return u.pathname === '/start'
      ? new Response(null, { status: 302, headers: { location: '/image.png' } })
      : new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/png' } })
  }) as unknown as typeof fetch
  const fetchImage = createExternalImageFetcher({ fetch: fakeFetch })

  const [first, second] = await Promise.all([
    fetchImage('https://example.com/start#ignored'),
    fetchImage('https://example.com/start'),
  ])

  expect(first.type).toBe('success')
  if (first.type !== 'success') throw new Error('unreachable')
  expect(first).toBe(second)
  expect(first.finalUrl.href).toBe('https://example.com/image.png')
  expect(first.status).toBe(200)
  expect(first.mediaType).toBe('image/png')
  expect([...first.data]).toEqual([1, 2, 3])
  expect(requested).toEqual(['https://example.com/start', 'https://example.com/image.png'])
})

test('rejects unsafe URL syntax before egress', async () => {
  let requests = 0
  const fakeFetch = (async () => {
    requests += 1
    return new Response()
  }) as unknown as typeof fetch
  const fetchImage = createExternalImageFetcher({ fetch: fakeFetch })

  expect(await fetchImage('file:///etc/passwd')).toEqual({ type: 'invalid-url' })
  expect(await fetchImage('https://user:secret@example.com/image.png')).toEqual({ type: 'invalid-url' })
  expect(await fetchImage('not a URL')).toEqual({ type: 'invalid-url' })
  expect(requests).toBe(0)
})

test('reports non-success and oversized (content-length) responses', async () => {
  const fakeFetch = (async (url: URL | string) => {
    const u = typeof url === 'string' ? new URL(url) : url
    return u.pathname === '/missing'
      ? new Response('missing', { status: 404 })
      : new Response(Uint8Array.of(1), { headers: { 'content-length': String(50 * 1024 * 1024 + 1) } })
  }) as unknown as typeof fetch
  const fetchImage = createExternalImageFetcher({ fetch: fakeFetch })

  expect(await fetchImage('https://example.com/missing')).toEqual({ type: 'http-error', status: 404 })
  expect(await fetchImage('https://example.com/oversized')).toEqual({ type: 'too-large', limitBytes: 50 * 1024 * 1024 })
})

test('bounds redirect chains', async () => {
  let requests = 0
  const fakeFetch = (async () => {
    requests += 1
    return new Response(null, { status: 302, headers: { location: `https://example.com/redirect-${requests}` } })
  }) as unknown as typeof fetch

  expect(await createExternalImageFetcher({ fetch: fakeFetch })('https://example.com/start')).toEqual({
    type: 'invalid-redirect',
    status: 302,
    reason: 'too-many-redirects',
  })
  expect(requests).toBe(6)
})

test('cancels a streamed body beyond the byte limit', async () => {
  const chunk = new Uint8Array(1024 * 1024)
  let cancelled = false
  const fakeFetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk) },
    cancel() { cancelled = true },
  }))) as unknown as typeof fetch

  expect(await createExternalImageFetcher({ fetch: fakeFetch })('https://example.com/large.png')).toEqual({
    type: 'too-large',
    limitBytes: 50 * 1024 * 1024,
  })
  expect(cancelled).toBe(true)
})

test('preserves transport failure detail', async () => {
  const expected = new Error('network unavailable')
  const fakeFetch = (async () => { throw expected }) as unknown as typeof fetch

  const result = await createExternalImageFetcher({ fetch: fakeFetch })('https://example.com/image.png')

  expect(result.type).toBe('transport-error')
  if (result.type !== 'transport-error') throw new Error('unreachable')
  expect(result.error).toBe(expected)
})

test('propagates downstream cancellation as an abort', async () => {
  const controller = new AbortController()
  const fakeFetch = (async () => { throw new Error('should not fetch') }) as unknown as typeof fetch
  const fetcher = createExternalImageFetcher({ fetch: fakeFetch, downstreamSignal: controller.signal })
  const reason = new Error('downstream cancelled')

  const promise = fetcher('https://example.com/image.png')
  controller.abort(reason)

  await expect(promise).rejects.toThrow('downstream cancelled')
})
