import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { fetchWithRetry } from '../fetch-retry.ts'
import { fetchOnStream } from '../fetch-on-stream.ts'

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

function earlyRawResponse(initialStatus: number) {
  const encoder = new TextEncoder()
  const streams: Array<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }> = []
  let attempts = 0
  let releaseWrite: () => void = () => {}
  let releaseClose: () => void = () => {}
  let closeStarted: () => void = () => {}
  const firstCloseStarted = new Promise<void>(resolve => { closeStarted = resolve })
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve })
  let oldWriteSettled = false
  let oldWriterLockedAtRetry: boolean | undefined
  const releaseOld = () => {
    releaseWrite()
    releaseClose()
  }
  const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
    attempts++
    const id = attempts
    if (id === 2) oldWriterLockedAtRetry = streams[0]?.writable.locked
    if (!(init.body instanceof Uint8Array)) throw new Error("expected original byte body")
    let responseController: ReadableStreamDefaultController<Uint8Array> | undefined
    const readable = new ReadableStream<Uint8Array>({
      start(controller) { responseController = controller },
    })
    let writes = 0
    const writable = new WritableStream<Uint8Array>({
      write() {
        writes++
        if (writes === 1) return
        if (writes === 2) {
          const status = id === 1 ? initialStatus : 200
          responseController?.enqueue(encoder.encode(`HTTP/1.1 ${status} Test\r\nContent-Length: 4\r\n\r\ntail`))
        }
        if (id !== 1) return
        return new Promise<void>((_resolve, reject) => {
          releaseWrite = () => {
            oldWriteSettled = true
            reject(new Error("fixture transport closed"))
          }
        })
      },
    })
    streams.push({ readable, writable })
    return fetchOnStream({ readable, writable }, {
      method: "POST", path: "/synthetic", headers: { Host: "fixture.invalid" }, body: init.body,
    }, undefined, {
      signal: init.signal ?? undefined,
      closeTransport: () => {
        if (id !== 1) return
        closeStarted()
        return closeGate
      },
    })
  }
  return {
    fetchImpl, firstCloseStarted, releaseOld, streams,
    get attempts() { return attempts },
    get oldWriteSettled() { return oldWriteSettled },
    get oldWriterLockedAtRetry() { return oldWriterLockedAtRetry },
  }
}

describe("fetchWithRetry over a raw byte stream", () => {
  for (const status of [429, 500]) {
    test(`waits for discarded ${status} transport cleanup before retrying`, async () => {
      const raw = earlyRawResponse(status)
      const pending = fetchWithRetry("https://fixture.invalid/synthetic", {
        method: "POST", body: new Uint8Array(32768), fetchImpl: raw.fetchImpl,
        maxRetries: 1, retryDelay: 1,
      })
      await raw.firstCloseStarted
      try {
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(raw.attempts).toBe(1)
        expect(raw.oldWriteSettled).toBe(false)
        expect(raw.streams[0]?.writable.locked).toBe(true)
      } finally {
        raw.releaseOld()
      }
      const response = await pending
      expect(response.status).toBe(200)
      expect(raw.attempts).toBe(2)
      expect(raw.oldWriteSettled).toBe(true)
      expect(raw.oldWriterLockedAtRetry).toBe(false)
      expect(await response.text()).toBe("tail")
      expect(raw.streams.every(stream => !stream.readable.locked && !stream.writable.locked)).toBe(true)
    })
  }

  test("caller abort stays prompt after backoff while cleanup is pending", async () => {
    const raw = earlyRawResponse(429)
    const caller = new AbortController()
    const reason = new Error("client left")
    const pending = fetchWithRetry("https://fixture.invalid/synthetic", {
      method: "POST", body: new Uint8Array(32768), fetchImpl: raw.fetchImpl,
      maxRetries: 1, retryDelay: 1, signal: caller.signal,
    })
    await raw.firstCloseStarted
    await new Promise(resolve => setTimeout(resolve, 20))
    try {
      caller.abort(reason)
      const result = await Promise.race([
        pending.then(() => "resolved", error => error),
        new Promise(resolve => setTimeout(() => resolve("abort was delayed"), 100)),
      ])
      expect(result).toBe(reason)
      expect(raw.attempts).toBe(1)
      expect(raw.oldWriteSettled).toBe(false)
    } finally {
      raw.releaseOld()
      await pending.catch(() => {})
    }
    expect(raw.streams.every(stream => !stream.readable.locked && !stream.writable.locked)).toBe(true)
  })

  test("header timeout is cleared while discarded response cleanup waits", async () => {
    const raw = earlyRawResponse(500)
    let firstSignal: AbortSignal | null | undefined
    const fetchImpl = (url: string, init: RequestInit) => {
      if (raw.attempts === 0) firstSignal = init.signal
      return raw.fetchImpl(url, init)
    }
    const pending = fetchWithRetry("https://fixture.invalid/synthetic", {
      method: "POST", body: new Uint8Array(32768), fetchImpl,
      maxRetries: 1, retryDelay: 1, timeout: 50,
    })
    await raw.firstCloseStarted
    try {
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(firstSignal?.aborted).toBe(false)
      expect(raw.attempts).toBe(1)
    } finally {
      raw.releaseOld()
    }
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("tail")
  })

  for (const status of [200, 413, 429, 500]) {
    test(`delivers final ${status} body without cancelling it`, async () => {
      const raw = earlyRawResponse(status)
      const response = await fetchWithRetry("https://fixture.invalid/synthetic", {
        method: "POST", body: new Uint8Array(32768), fetchImpl: raw.fetchImpl,
        maxRetries: 0, retryDelay: 0,
      })
      expect(response.status).toBe(status)
      expect(raw.attempts).toBe(1)
      expect(raw.oldWriteSettled).toBe(false)
      raw.releaseOld()
      expect(await response.text()).toBe("tail")
      expect(raw.streams.every(stream => !stream.readable.locked && !stream.writable.locked)).toBe(true)
    })
  }

  test("retries a bodyless status response after the configured delay", async () => {
    let attempts = 0
    const started = performance.now()
    let secondStart = 0
    const fetchImpl = async (): Promise<Response> => {
      attempts++
      if (attempts === 1) return new Response(null, { status: 503 })
      secondStart = performance.now()
      return new Response("tail", { status: 200 })
    }
    const response = await fetchWithRetry("https://fixture.invalid/synthetic", {
      fetchImpl, maxRetries: 1, retryDelay: 30,
    })
    expect(attempts).toBe(2)
    expect(secondStart - started).toBeGreaterThanOrEqual(25)
    expect(await response.text()).toBe("tail")
  })

  test("a rejected discarded-body cancellation does not replace the HTTP retry", async () => {
    let attempts = 0
    let cancelCalled = false
    const fetchImpl = async (): Promise<Response> => {
      attempts++
      if (attempts === 1) {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelCalled = true
            throw new Error("cleanup failed")
          },
        })
        return new Response(body, { status: 503 })
      }
      if (attempts === 2) return new Response("tail", { status: 200 })
      throw new Error("unexpected extra retry")
    }
    const response = await fetchWithRetry("https://fixture.invalid/synthetic", {
      fetchImpl, maxRetries: 1, retryDelay: 0,
    })
    expect(cancelCalled).toBe(true)
    expect(attempts).toBe(2)
    expect(await response.text()).toBe("tail")
  })
})

test('a discovery fetcher lifetime cancels retry backoff even without RequestInit.signal', async () => {
  const controller = new AbortController()
  let calls = 0
  const fetchImpl = Object.assign(async () => { calls++; return new Response('retry', { status: 503 }) }, { signal: controller.signal })
  const pending = fetchWithRetry('https://example.invalid', { fetchImpl, retryDelay: 50 })
  await Bun.sleep(5)
  controller.abort(new Error('discovery ended'))
  await expect(pending).rejects.toThrow('discovery ended')
  expect(calls).toBe(1)
})

for (const abortLifetime of [false, true]) test(`composed retry cancellation honors ${abortLifetime ? 'transport lifetime' : 'request'} signal`, async () => {
  const lifetime = new AbortController(), request = new AbortController()
  let calls = 0
  const fetchImpl = Object.assign(async (_: string, init: RequestInit) => {
    calls++
    expect(init.signal?.aborted).toBe(false)
    return new Response('retry', { status: 503 })
  }, { signal: lifetime.signal })
  const pending = fetchWithRetry('https://example.invalid', { fetchImpl, signal: request.signal, retryDelay: 1000 })
  await Bun.sleep(5)
  const selected = abortLifetime ? lifetime : request
  selected.abort(new Error('selected cancel'))
  await expect(pending).rejects.toThrow('selected cancel')
  expect(calls).toBe(1)
  expect((abortLifetime ? request : lifetime).signal.aborted).toBe(false)
})
