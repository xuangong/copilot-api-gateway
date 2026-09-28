import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { fetchWithRetry } from '../fetch-retry.ts'

const realFetch = globalThis.fetch

describe('fetchWithRetry', () => {
  let calls: Array<{ url: string; init?: RequestInit }>
  let responses: Array<() => Response | Promise<Response> | never>

  beforeEach(() => {
    calls = []
    responses = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(init === undefined ? { url: String(input) } : { url: String(input), init })
      const i = calls.length - 1
      const factory = responses[i]
      if (!factory) throw new Error(`unexpected fetch #${i + 1}`)
      return factory()
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('returns 200 on first success without retrying', async () => {
    responses.push(() => new Response('ok', { status: 200 }))
    const res = await fetchWithRetry('https://example.com')
    expect(res.status).toBe(200)
    expect(calls.length).toBe(1)
  })

  test('retries on 5xx and returns final success', async () => {
    responses.push(() => new Response('boom', { status: 503 }))
    responses.push(() => new Response('ok', { status: 200 }))
    const res = await fetchWithRetry('https://example.com', { retryDelay: 1 })
    expect(res.status).toBe(200)
    expect(calls.length).toBe(2)
  })

  test('retries on 429 and returns final success', async () => {
    responses.push(() => new Response('rate', { status: 429 }))
    responses.push(() => new Response('ok', { status: 200 }))
    const res = await fetchWithRetry('https://example.com', { retryDelay: 1 })
    expect(res.status).toBe(200)
    expect(calls.length).toBe(2)
  })

  test('does NOT retry on 4xx (other than 429) and returns the 4xx response', async () => {
    responses.push(() => new Response('bad', { status: 400 }))
    const res = await fetchWithRetry('https://example.com', { retryDelay: 1, maxRetries: 3 })
    expect(res.status).toBe(400)
    expect(calls.length).toBe(1)
  })

  test('returns the final 5xx response after exhausting maxRetries', async () => {
    responses.push(() => new Response('a', { status: 500 }))
    responses.push(() => new Response('b', { status: 502 }))
    responses.push(() => new Response('c', { status: 503 }))
    responses.push(() => new Response('d', { status: 504 }))
    const res = await fetchWithRetry('https://example.com', { retryDelay: 1, maxRetries: 3 })
    expect(res.status).toBe(504)
    expect(calls.length).toBe(4)
  })

  test('timeout triggers AbortController and throws with timeout message', async () => {
    responses.push(() => new Promise<Response>((_resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      const init = calls[calls.length - 1]?.init
      init?.signal?.addEventListener('abort', onAbort, { once: true })
    }))
    await expect(
      fetchWithRetry('https://example.com', { timeout: 5, maxRetries: 0 }),
    ).rejects.toThrow(/timeout after 5ms/)
  })

  test('a timed-out attempt retries and can return a later successful response', async () => {
    responses.push(() => new Promise<Response>((_resolve, reject) => {
      calls[0]?.init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    responses.push(() => new Response('ok'))
    const result = await fetchWithRetry('https://example.com', {
      timeout: 5, maxRetries: 1, retryDelay: 1,
    })
    expect(await result.text()).toBe('ok')
    expect(calls).toHaveLength(2)
  })

  test('pre-aborted caller stops before the first fetch and preserves its reason', async () => {
    const controller = new AbortController()
    const reason = new Error('client left')
    controller.abort(reason)
    await expect(fetchWithRetry('https://example.com', {
      signal: controller.signal, timeout: 50, maxRetries: 2,
    })).rejects.toBe(reason)
    expect(calls).toHaveLength(0)
  })

  test('caller abort interrupts a pending timed fetch without retrying', async () => {
    const controller = new AbortController()
    const reason = new Error('client left')
    responses.push(() => new Promise<Response>((_resolve, reject) => {
      calls[0]?.init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const pending = fetchWithRetry('https://example.com', {
      signal: controller.signal, timeout: 1000, maxRetries: 2, retryDelay: 1000,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(calls).toHaveLength(1)
  })

  test('caller abort interrupts retry backoff and releases the discarded body', async () => {
    const controller = new AbortController()
    const reason = new Error('client left')
    let bodyCancelled = false
    const response = new Response(new ReadableStream({
      cancel() { bodyCancelled = true },
    }), { status: 503 })
    responses.push(() => response)
    const pending = fetchWithRetry('https://example.com', {
      signal: controller.signal, retryDelay: 1000,
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(bodyCancelled).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('caller abort remains connected to response body after headers with timeout', async () => {
    const controller = new AbortController()
    responses.push(() => {
      const signal = calls[0]?.init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          signal?.addEventListener('abort', () => stream.error(signal.reason), { once: true })
        },
      })
      return new Response(body)
    })
    const response = await fetchWithRetry('https://example.com', {
      signal: controller.signal, timeout: 1000, maxRetries: 0,
    })
    const reason = new Error('client left')
    const reading = response.text()
    controller.abort(reason)
    await expect(reading).rejects.toBe(reason)
    expect(calls[0]?.init?.signal?.aborted).toBe(true)
  })
})
