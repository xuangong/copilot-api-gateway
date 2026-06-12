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
      calls.push({ url: String(input), init })
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
})
