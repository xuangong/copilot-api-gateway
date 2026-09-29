import { describe, expect, it } from 'bun:test'
import { ReplayBodyError, type ReplayableBody } from '@vibe-core/platform'
import { fetchOnStream as rawFetchOnStream, type FetchOnStreamOptions } from '../fetch-on-stream.ts'
import type { DuplexStream, HttpRequest } from '../types.ts'
import { closeFakeDuplex, makeFakeDuplex } from './test-utils.ts'

const fetchOnStream = (
  stream: DuplexStream,
  request: HttpRequest,
  prefix?: Uint8Array,
  options?: Partial<FetchOnStreamOptions>,
): Promise<Response> => rawFetchOnStream(stream, request, prefix, {
  closeTransport: options?.closeTransport ?? (() => closeFakeDuplex(stream.readable)),
  signal: options?.signal,
})

const enc = new TextEncoder()
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const body = (contentLength: number, open: ReplayableBody['open']): ReplayableBody => ({ kind: 'replayable', contentLength, open })
const req = (value: Uint8Array | ReplayableBody) => ({ method: 'POST', path: '/', headers: { Host: 'h', 'Content-Length': '999', 'Transfer-Encoding': 'chunked' }, body: value })
const until = async (check: () => boolean): Promise<void> => {
  for (let n = 0; n < 1000; n++) { if (check()) return; await Bun.sleep(1) }
  throw new Error('controlled event did not arrive')
}

describe('replay HTTP transport', () => {
  it('validates length and pre-abort before open or dispatch', async () => {
    for (const length of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      const fake = makeFakeDuplex()
      let opens = 0
      await expect(fetchOnStream(fake, req(body(length, () => { opens++; return new ReadableStream() })))).rejects.toMatchObject({ code: 'INVALID_LENGTH' })
      expect(opens).toBe(0)
      expect(fake.written().byteLength).toBe(0)
    }
    const controller = new AbortController()
    controller.abort()
    let opens = 0
    await expect(fetchOnStream(makeFakeDuplex(), req(body(1, () => { opens++; return new ReadableStream() })), undefined, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
    expect(opens).toBe(0)
  })

  it('opens once, emits exact zero framing, and strips conflicting framing', async () => {
    const fake = makeFakeDuplex()
    let opens = 0
    const response = fetchOnStream(fake, req(body(0, () => {
      opens++
      return new ReadableStream({ start(c) { c.close() } })
    })))
    await until(() => opens === 1)
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')
    fake.endResponse()
    expect((await response).status).toBe(200)
    const wire = text(fake.written())
    expect(wire).toContain('Content-Length: 0\r\n')
    expect(wire).not.toContain('Content-Length: 999')
    expect(wire).not.toContain('Transfer-Encoding:')
  })

  it('splits one huge source chunk into bounded writes with exact bytes and prefix', async () => {
    const fake = makeFakeDuplex()
    const sizes: number[] = []
    const writable = new WritableStream<Uint8Array>({ write(chunk) {
      sizes.push(chunk.byteLength)
      const writer = fake.writable.getWriter()
      return writer.write(chunk).finally(() => writer.releaseLock())
    } })
    let opens = 0
    const payload = new Uint8Array(100000).fill(65)
    const response = fetchOnStream({ readable: fake.readable, writable }, req(body(payload.byteLength, () => {
      opens++
      return new ReadableStream({ start(c) { c.enqueue(payload); c.close() } })
    })), enc.encode('PREFIX'))
    await until(() => sizes.length === 8)
    fake.respond('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')
    fake.endResponse()
    expect((await response).status).toBe(200)
    expect(opens).toBe(1)
    expect(sizes.slice(1)).toEqual([16384, 16384, 16384, 16384, 16384, 16384, 1696])
    const wire = text(fake.written())
    expect(wire.startsWith('PREFIXPOST / HTTP/1.1\r\n')).toBe(true)
    expect(wire.endsWith('A'.repeat(100000))).toBe(true)
  })

  it('treats natural short, long and thrown producers as typed terminal errors', async () => {
    const cases: Array<{ value: ReplayableBody; code: string }> = [
      { value: body(2, () => new ReadableStream({ start(c) { c.enqueue(enc.encode('x')); c.close() } })), code: 'UNDERRUN' },
      { value: body(1, () => new ReadableStream({ start(c) { c.enqueue(enc.encode('xy')); c.close() } })), code: 'OVERRUN' },
      { value: body(1, () => new ReadableStream({ start(c) { c.error(new Error('producer failed')) } })), code: 'PRODUCER' },
    ]
    for (const { value, code } of cases) {
      const fake = makeFakeDuplex()
      let closes = 0
      const failure = await fetchOnStream(fake, req(value), undefined, { closeTransport() { closes++; fake.endResponse() } }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ReplayBodyError)
      expect(failure).toHaveProperty('code', code)
      expect(closes).toBe(1)
      if (code === 'OVERRUN') expect(text(fake.written()).endsWith('xy')).toBe(false)
    }
  })

  for (const status of [200, 413, 204]) {
    it(`preserves early ${status} with a blocked source read`, async () => {
      const fake = makeFakeDuplex()
      let opened = 0, cancelled = 0, closed = 0
      let source: ReadableStream<Uint8Array> | undefined
      const response = fetchOnStream(fake, req(body(100, () => {
        opened++
        source = new ReadableStream({ pull() { return new Promise<void>(() => {}) }, cancel() { cancelled++ } }, { highWaterMark: 0 })
        return source
      })), undefined, { closeTransport() { closed++; fake.endResponse() } })
      await until(() => opened === 1)
      fake.respond(`HTTP/1.1 ${status} Early\r\nContent-Length: ${status === 204 ? 0 : 10}\r\n\r\n${status === 204 ? '' : 'early-'}`)
      const result = await response
      expect(result.status).toBe(status)
      await until(() => cancelled === 1)
      if (status === 204) {
        expect(result.body).toBeNull()
        await until(() => closed === 1)
      } else {
        expect(closed).toBe(0)
        fake.respond('tail')
        expect(await result.text()).toBe('early-tail')
        await until(() => closed === 1)
      }
      expect(source?.locked).toBe(false)
      expect(fake.writable.locked).toBe(false)
    })
  }

  it('holds a blocked write until response EOF initiates concrete close', async () => {
    let incoming: ReadableStreamDefaultController<Uint8Array> | undefined
    let rejectWrite: ((error: unknown) => void) | undefined
    let writes = 0, cancelled = 0, closed = 0
    const readable = new ReadableStream<Uint8Array>({ start(c) { incoming = c } })
    const writable = new WritableStream<Uint8Array>({ write() {
      writes++
      if (writes === 1) return
      return new Promise<void>((_resolve, reject) => { rejectWrite = reject })
    } })
    const response = fetchOnStream({ readable, writable }, req(body(100000, () => new ReadableStream({
      pull(c) { c.enqueue(new Uint8Array(65536)) }, cancel() { cancelled++ },
    }, { highWaterMark: 0 }))), undefined, {
      closeTransport() { closed++; rejectWrite?.(new Error('socket closed')); incoming?.close() },
    })
    await until(() => writes === 2)
    incoming?.enqueue(enc.encode('HTTP/1.1 413 Early\r\nContent-Length: 10\r\n\r\nearly-'))
    const result = await response
    expect(result.status).toBe(413)
    expect(writable.locked).toBe(true)
    expect(closed).toBe(0)
    incoming?.enqueue(enc.encode('tail'))
    expect(await result.text()).toBe('early-tail')
    expect(closed).toBe(1)
    expect(cancelled).toBe(1)
    expect(writable.locked).toBe(false)
  })

  it('errors a returned body on caller abort', async () => {
    const fake = makeFakeDuplex()
    const controller = new AbortController()
    let cancelled = 0, closed = 0
    const response = fetchOnStream(fake, req(body(100, () => new ReadableStream({
      pull() { return new Promise<void>(() => {}) }, cancel() { cancelled++ },
    }, { highWaterMark: 0 }))), undefined, {
      signal: controller.signal, closeTransport() { closed++; fake.endResponse() },
    })
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nearly-')
    const result = await response
    const reading = result.text()
    controller.abort()
    await expect(reading).rejects.toHaveProperty('name', 'AbortError')
    await until(() => closed === 1 && cancelled === 1)
    expect(fake.writable.locked).toBe(false)
  })
})

describe('raw response ownership races', () => {
  it('preserves an early byte-body 413 and cancels response on consumer cancel', async () => {
    const fake = makeFakeDuplex()
    let closes = 0
    const response = fetchOnStream(fake, req(new Uint8Array(100000).fill(65)), undefined, {
      closeTransport() { closes++; fake.endResponse() },
    })
    fake.respond('HTTP/1.1 413 Early\r\nContent-Length: 10\r\n\r\nearly-')
    const result = await response
    expect(result.status).toBe(413)
    await result.body?.cancel('not needed')
    await until(() => closes === 1)
    expect(fake.writable.locked).toBe(false)
  })

  it('reports parser failure and releases a blocked source reader', async () => {
    const fake = makeFakeDuplex()
    let opened = 0, cancelled = 0, closes = 0
    const response = fetchOnStream(fake, req(body(100, () => {
      opened++
      return new ReadableStream({ pull() { return new Promise<void>(() => {}) }, cancel() { cancelled++ } }, { highWaterMark: 0 })
    })), undefined, { closeTransport() { closes++; fake.endResponse() } })
    await until(() => opened === 1)
    fake.respond('HTTP/1.1 BAD\r\n\r\n')
    await expect(response).rejects.toHaveProperty('code', 'BAD_STATUS_LINE')
    expect(cancelled).toBe(1)
    expect(closes).toBe(1)
    expect(fake.writable.locked).toBe(false)
  })

  it('keeps a producer failure that occurs before a later final head', async () => {
    const fake = makeFakeDuplex()
    let started = false, releaseFailure: (() => void) | undefined, closes = 0
    const response = fetchOnStream(fake, req(body(1, () => new ReadableStream({
      async pull(controller) {
        started = true
        await new Promise<void>(resolve => { releaseFailure = resolve })
        controller.error(new Error('producer first'))
      },
    }, { highWaterMark: 0 }))), undefined, { closeTransport() { closes++; fake.endResponse() } })
    await until(() => started && releaseFailure !== undefined)
    releaseFailure?.()
    const failure = await response.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ReplayBodyError)
    expect(failure).toHaveProperty('code', 'PRODUCER')
    expect(closes).toBe(1)
  })
})

describe('teardown without a body consumer', () => {
  it('rejects a missing concrete close hook before locks, body open or request I/O', async () => {
    const fake = makeFakeDuplex()
    let opens = 0
    const result = await rawFetchOnStream(fake, req(body(1, () => {
      opens++
      return new ReadableStream()
    })), undefined, undefined as unknown as FetchOnStreamOptions).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(TypeError)
    expect((result as Error).message).toContain('closeTransport')
    expect(opens).toBe(0)
    expect(fake.written().byteLength).toBe(0)
    expect(fake.readable.locked).toBe(false)
    expect(fake.writable.locked).toBe(false)
  })

  for (const mode of ['throw', 'reject'] as const) {
    it(`settles despite a concrete close callback that ${mode}s`, async () => {
      const fake = makeFakeDuplex()
      let closes = 0
      const closeTransport = (): Promise<void> => {
        closes++
        if (mode === 'throw') throw new Error('close threw')
        return Promise.reject(new Error('close rejected'))
      }
      const result = await fetchOnStream(fake, req(body(1, () => new ReadableStream({ start(c) { c.close() } }))), undefined, { closeTransport }).catch((error: unknown) => error)
      expect(result).toBeInstanceOf(ReplayBodyError)
      expect(result).toHaveProperty('code', 'UNDERRUN')
      expect(closes).toBe(1)
      expect(fake.readable.locked).toBe(false)
    })
  }

  it('releases parser and upload locks when caller aborts after headers without reading', async () => {
    const fake = makeFakeDuplex()
    const controller = new AbortController()
    let cancelled = 0, closed = 0
    const resultPromise = fetchOnStream(fake, req(body(100, () => new ReadableStream({
      pull() { return new Promise<void>(() => {}) }, cancel() { cancelled++ },
    }, { highWaterMark: 0 }))), undefined, {
      signal: controller.signal, closeTransport() { closed++; fake.endResponse() },
    })
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nearly-')
    const result = await resultPromise
    expect(result.status).toBe(200)
    controller.abort()
    await until(() => closed === 1 && cancelled === 1 && !fake.readable.locked && !fake.writable.locked)
    await expect(result.text()).rejects.toHaveProperty('name', 'AbortError')
  })
})

describe('producer classification before final-head microtask', () => {
  for (const ending of ['error', 'eof'] as const) {
    it(`keeps ${ending} terminal after the actual 413 head is already enqueued`, async () => {
      let incoming: ReadableStreamDefaultController<Uint8Array> | undefined
      let producer: ReadableStreamDefaultController<Uint8Array> | undefined
      let ready: () => void = () => {}
      const started = new Promise<void>(resolve => { ready = resolve })
      let closes = 0
      const readable = new ReadableStream<Uint8Array>({ start(controller) { incoming = controller } })
      const writable = new WritableStream<Uint8Array>({ write() {} })
      const exchange = rawFetchOnStream({ readable, writable }, req(body(1, () => new ReadableStream<Uint8Array>({
        start(controller) { producer = controller },
        pull() { ready(); return new Promise<void>(() => {}) },
      }, { highWaterMark: 0 }))), undefined, { closeTransport() { closes++ } })
      await started
      incoming?.enqueue(enc.encode('HTTP/1.1 413 Early\r\nContent-Length: 1\r\n\r\n'))
      // This fixed gate reproduces the former gap between upload throwing and
      // its separately scheduled rejection observer claiming the cause.
      for (let n = 0; n < 3; n++) await Promise.resolve()
      if (ending === 'error') producer?.error(new Error('producer failed first'))
      else producer?.close()
      const failure = await exchange.catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ReplayBodyError)
      expect(failure).toHaveProperty('code', ending === 'error' ? 'PRODUCER' : 'UNDERRUN')
      expect(closes).toBe(1)
      expect(readable.locked).toBe(false)
      expect(writable.locked).toBe(false)
    })
  }
})
