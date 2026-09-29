/**
 * Dial-chain behaviour. Ported from copilot-gateway's
 * packages/gateway/__tests__/dial/fetcher_test.ts, trimmed to the cases that
 * pin the semantics the gateway relies on: two-pass ordering, backoff
 * bookkeeping, the implicit direct-connect default, and body replay.
 */
import { test, expect } from 'bun:test'
import { createFetcher } from '../fetcher.ts'
import type { DialObserver, DialAttemptInput } from '../fetcher.ts'
import type { ProxyEntry } from '../proxy-catalog.ts'
import { ProxyDialError, type ProxyConfig } from '@vibe-core/proxy'
import type { SocketDial } from '@vibe-core/platform'
import {
  BACKOFF_BASE_SECONDS,
  type BackoffRow,
  type ProxyBackoffRepo,
} from '@vibe-core/proxy-repo'

const stubSocketDial: SocketDial = {
  connect: async () => {
    throw new Error('stub socket dial — transports are injected, this must not be called')
  },
}

// Minimal mirror of the SQL schedule: failure UPSERTs and advances 60·2^(n-1),
// success deletes the row. Only the three methods createFetcher reads.
const fakeBackoffs = () => {
  const rows = new Map<string, BackoffRow>()
  const repo: Pick<ProxyBackoffRepo, 'listForUpstream' | 'recordDialFailure' | 'recordDialSuccess'> =
    {
      async recordDialFailure(proxyId, upstreamId, errorMessage) {
        const key = `${proxyId}:${upstreamId}`
        const prev = rows.get(key)
        const failCount = (prev?.failCount ?? 0) + 1
        const now = Math.floor(Date.now() / 1000)
        rows.set(key, {
          proxyId,
          upstreamId,
          failCount,
          expiresAt: now + BACKOFF_BASE_SECONDS * 2 ** (failCount - 1),
          lastError: errorMessage,
          lastErrorAt: now,
        })
      },
      async recordDialSuccess(proxyId, upstreamId) {
        rows.delete(`${proxyId}:${upstreamId}`)
      },
      async listForUpstream(upstreamId) {
        return [...rows.values()].filter((r) => r.upstreamId === upstreamId)
      },
    }
  return { repo, rows }
}

const proxyA: ProxyEntry = {
  config: { kind: 'socks5', host: 'a', port: 1, name: 'a' } as ProxyConfig,
  dialTimeoutMs: null,
}
const proxyB: ProxyEntry = {
  config: { kind: 'socks5', host: 'b', port: 1, name: 'b' } as ProxyConfig,
  dialTimeoutMs: null,
}

const okDirectConnect = async () => new Response('direct connect')

test('first pass skips backed-off entries and short-circuits on success', async () => {
  const { repo } = fakeBackoffs()
  await repo.recordDialFailure('a', 'u', 'x')
  const calls: string[] = []
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'a' }, { id: 'b' }, { id: 'direct_fetch' }],
    runtimeLocation: 'TEST',
    proxyById: new Map([
      ['a', proxyA],
      ['b', proxyB],
    ]),
    runProxied: async (config) => {
      calls.push(config.host)
      return new Response('ok')
    },
    runDirectFetch: async () => {
      calls.push('direct')
      return new Response('direct')
    },
    runDirectConnect: okDirectConnect,
    socketDial: () => stubSocketDial,
  })
  const res = await fetcher('https://api.openai.com/v1/models', { method: 'GET' })
  expect(await res.text()).toBe('ok')
  expect(calls).toEqual(['b'])
})

test('an entry that fails in pass 1 is not retried in pass 2', async () => {
  const { repo } = fakeBackoffs()
  let attempts = 0
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'a' }],
    runtimeLocation: 'TEST',
    proxyById: new Map([['a', proxyA]]),
    runProxied: async () => {
      attempts += 1
      throw new ProxyDialError('boom', 'tcp-connect')
    },
    runDirectFetch: async () => new Response('ok'),
    runDirectConnect: okDirectConnect,
    socketDial: () => stubSocketDial,
  })
  await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(
    ProxyDialError,
  )
  expect(attempts).toBe(1)
  // One real failure must advance the geometric schedule by exactly one step.
  const [row] = await repo.listForUpstream('u')
  expect(row!.failCount).toBe(1)
})

test('pass 2 walks the entries pass 1 skipped, and success clears the backoff', async () => {
  const { repo } = fakeBackoffs()
  await repo.recordDialFailure('a', 'u', 'x')
  await repo.recordDialFailure('a', 'u', 'x')
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'a' }],
    runtimeLocation: 'TEST',
    proxyById: new Map([['a', proxyA]]),
    runProxied: async () => new Response('ok'),
    runDirectFetch: async () => new Response('unused'),
    runDirectConnect: okDirectConnect,
    socketDial: () => stubSocketDial,
  })
  const res = await fetcher('https://api.openai.com', { method: 'GET' })
  expect(await res.text()).toBe('ok')
  expect(await repo.listForUpstream('u')).toEqual([])
})

test('an empty fallback list resolves to direct_connect, not runtime fetch', async () => {
  const { repo } = fakeBackoffs()
  const hit: string[] = []
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [],
    runtimeLocation: 'TEST',
    proxyById: new Map(),
    runProxied: async () => new Response('proxy'),
    runDirectFetch: async () => {
      hit.push('direct_fetch')
      return new Response('direct fetch')
    },
    runDirectConnect: async (target, request) => {
      hit.push('direct_connect')
      expect(target).toEqual({ host: 'api.openai.com', port: 443, tls: true })
      expect(request.path).toBe('/v1/models')
      return new Response('direct connect')
    },
    socketDial: () => stubSocketDial,
  })
  const res = await fetcher('https://api.openai.com/v1/models', { method: 'GET' })
  expect(await res.text()).toBe('direct connect')
  expect(hit).toEqual(['direct_connect'])
})

test('a colo-filtered-out list collapses to the same direct_connect default', async () => {
  const { repo } = fakeBackoffs()
  let directConnects = 0
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'a', colos: ['LHR'] }],
    runtimeLocation: 'SJC',
    proxyById: new Map([['a', proxyA]]),
    runProxied: async () => {
      throw new Error('colo-excluded proxy must not be dialled')
    },
    runDirectFetch: async () => new Response('direct fetch'),
    runDirectConnect: async () => {
      directConnects += 1
      return new Response('direct connect')
    },
    socketDial: () => stubSocketDial,
  })
  expect(await (await fetcher('https://api.openai.com', { method: 'GET' })).text()).toBe(
    'direct connect',
  )
  expect(directConnects).toBe(1)
})

test('a direct_fetch-only list keeps the caller body untouched (no materialization)', async () => {
  const { repo } = fakeBackoffs()
  const body = new FormData()
  body.set('field', 'value')
  let seen: unknown
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'direct_fetch' }],
    runtimeLocation: 'TEST',
    proxyById: new Map(),
    runProxied: async () => new Response('proxy'),
    runDirectFetch: async (_url, init) => {
      seen = init.body
      return new Response('ok')
    },
    runDirectConnect: okDirectConnect,
    socketDial: () => stubSocketDial,
  })
  await fetcher('https://api.openai.com', { method: 'POST', body })
  expect(seen).toBe(body)
})

// Regression: `collectBody` used to read the multipart Content-Type back off
// `new Request(url, { body: formData }).headers`, which Bun leaves unset. The
// body then travelled as raw bytes with no Content-Type at all, and upstreams
// fell back to parsing it as JSON ("LLM API: Invalid JSON format").
test('materializing a FormData body keeps the multipart content-type', async () => {
  const { repo } = fakeBackoffs()
  const body = new FormData()
  body.set('model', 'm')
  body.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png')
  let seenHeaders: Record<string, string> | undefined
  let seenBody: Uint8Array | undefined
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'direct_connect' }],
    runtimeLocation: 'TEST',
    proxyById: new Map(),
    runProxied: async () => new Response('proxy'),
    runDirectFetch: async () => new Response('direct fetch'),
    runDirectConnect: async (_target, request) => {
      seenHeaders = request.headers
      seenBody = request.body
      return new Response('ok')
    },
    socketDial: () => stubSocketDial,
  })
  await fetcher('https://api.openai.com', { method: 'POST', body })
  const ct = seenHeaders?.['content-type']
  expect(ct).toMatch(/^multipart\/form-data; boundary=.+/)
  // The declared boundary must be the one the serialized body actually uses,
  // or the upstream cannot split the parts.
  const boundary = ct!.slice(ct!.indexOf('boundary=') + 'boundary='.length)
  expect(new TextDecoder().decode(seenBody!)).toStartWith(`--${boundary}\r\n`)
})

test('a caller-set content-type still wins over the synthesized one', async () => {
  const { repo } = fakeBackoffs()
  const body = new FormData()
  body.set('field', 'value')
  let seenHeaders: Record<string, string> | undefined
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'direct_connect' }],
    runtimeLocation: 'TEST',
    proxyById: new Map(),
    runProxied: async () => new Response('proxy'),
    runDirectFetch: async () => new Response('direct fetch'),
    runDirectConnect: async (_target, request) => {
      seenHeaders = request.headers
      return new Response('ok')
    },
    socketDial: () => stubSocketDial,
  })
  await fetcher('https://api.openai.com', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-custom' },
  })
  expect(seenHeaders?.['content-type']).toBe('application/x-custom')
})

test('a ReadableStream body is rejected when a materialized transport is in play', async () => {
  const { repo } = fakeBackoffs()
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'direct_connect' }],
    runtimeLocation: 'TEST',
    proxyById: new Map(),
    runProxied: async () => new Response('proxy'),
    runDirectFetch: async () => new Response('direct fetch'),
    runDirectConnect: okDirectConnect,
    socketDial: () => stubSocketDial,
  })
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('x'))
      c.close()
    },
  })
  await expect(fetcher('https://api.openai.com', { method: 'POST', body })).rejects.toThrow(
    /not replayable/,
  )
})

test('a materialized proxy attempt replays the same bytes to a later direct fallback', async () => {
  const { repo } = fakeBackoffs()
  const init: RequestInit = { method: 'POST', body: 'hello' }
  let directBody: unknown
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
    runtimeLocation: 'TEST',
    proxyById: new Map([['a', proxyA]]),
    runProxied: async (_config, _target, request) => {
      expect(new TextDecoder().decode(request.body)).toBe('hello')
      throw new ProxyDialError('boom', 'tcp-connect')
    },
    runDirectFetch: async (_url, i) => {
      directBody = i.body
      return new Response('ok')
    },
    runDirectConnect: okDirectConnect,
    socketDial: () => stubSocketDial,
  })
  const res = await fetcher('https://api.openai.com', init)
  expect(await res.text()).toBe('ok')
  expect(new TextDecoder().decode(directBody as Uint8Array)).toBe('hello')
  // The caller's own init object must survive the replay untouched.
  expect(init.body).toBe('hello')
})

test('an unknown proxy id advances the chain without writing a backoff row', async () => {
  const { repo, rows } = fakeBackoffs()
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'gone' }, { id: 'direct_fetch' }],
    runtimeLocation: 'TEST',
    proxyById: new Map(),
    runProxied: async () => new Response('proxy'),
    runDirectFetch: async () => new Response('ok'),
    runDirectConnect: okDirectConnect,
    socketDial: () => stubSocketDial,
  })
  expect(await (await fetcher('https://api.openai.com', { method: 'GET' })).text()).toBe('ok')
  expect(rows.size).toBe(0)
})

test('an AbortError stops the chain instead of falling through', async () => {
  const { repo } = fakeBackoffs()
  let directFetches = 0
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
    runtimeLocation: 'TEST',
    proxyById: new Map([['a', proxyA]]),
    runProxied: async () => {
      throw new DOMException('aborted', 'AbortError')
    },
    runDirectFetch: async () => {
      directFetches += 1
      return new Response('ok')
    },
    runDirectConnect: okDirectConnect,
    socketDial: () => stubSocketDial,
  })
  await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toThrow(/aborted/)
  expect(directFetches).toBe(0)
})

test('the failed dial stage is persisted in the backoff lastError tag', async () => {
  const { repo } = fakeBackoffs()
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
    runtimeLocation: 'TEST',
    proxyById: new Map([['a', proxyA]]),
    runProxied: async () => {
      throw new ProxyDialError('cert mismatch', 'inner-tls')
    },
    runDirectFetch: async () => new Response('ok'),
    runDirectConnect: okDirectConnect,
    socketDial: () => stubSocketDial,
  })
  await fetcher('https://api.openai.com', { method: 'GET' })
  const [row] = await repo.listForUpstream('u')
  expect(row!.lastError).toBe('[inner-tls] cert mismatch')
})

test('the IPv6 envelope is stripped before the target reaches the dialer', async () => {
  const { repo } = fakeBackoffs()
  let host: string | undefined
  const fetcher = createFetcher({
    proxyBackoffs: repo,
    upstreamId: 'u',
    fallbackList: [{ id: 'direct_connect' }],
    runtimeLocation: 'TEST',
    proxyById: new Map(),
    runProxied: async () => new Response('proxy'),
    runDirectFetch: async () => new Response('direct fetch'),
    runDirectConnect: async (target) => {
      host = target.host
      return new Response('ok')
    },
    socketDial: () => stubSocketDial,
  })
  await fetcher('https://[2001:db8::1]:8443/v1', { method: 'GET' })
  expect(host).toBe('2001:db8::1')
})

const workerdFailure = new Error('proxy request failed, cannot connect to the specified address: blocked')
const classifiedSocketDial: SocketDial = {
  connect: async () => { throw workerdFailure },
  shouldConnectErrorFallbackToFetch: (error: unknown) => error === workerdFailure,
}
const classifiedFailure = () => new ProxyDialError('tcp failed', 'tcp-connect', { cause: workerdFailure })

test('classified pre-dispatch direct-connect failure uses one implicit fetch without backoff writes', async () => {
  const { repo, rows } = fakeBackoffs()
  const calls: string[] = []
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'u', fallbackList: [], runtimeLocation: 'TEST', proxyById: new Map(),
    runProxied: async () => { throw new Error('unused') },
    runDirectFetch: async () => { calls.push('fetch'); return new Response('fallback') },
    runDirectConnect: async () => { calls.push('connect'); throw classifiedFailure() },
    socketDial: () => classifiedSocketDial,
  })
  expect(await (await fetcher('https://api.openai.com', { method: 'GET' })).text()).toBe('fallback')
  expect(calls).toEqual(['connect', 'fetch'])
  expect(rows.size).toBe(0)
})

test('a later configured proxy succeeds before an implicit fetch', async () => {
  const { repo } = fakeBackoffs()
  const calls: string[] = []
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'u', fallbackList: [{ id: 'direct_connect' }, { id: 'a' }],
    runtimeLocation: 'TEST', proxyById: new Map([['a', proxyA]]),
    runProxied: async () => { calls.push('proxy'); return new Response('proxy') },
    runDirectFetch: async () => { calls.push('fetch'); return new Response('fetch') },
    runDirectConnect: async () => { calls.push('connect'); throw classifiedFailure() },
    socketDial: () => classifiedSocketDial,
  })
  expect(await (await fetcher('https://api.openai.com', { method: 'GET' })).text()).toBe('proxy')
  expect(calls).toEqual(['connect', 'proxy'])
})

test('uncertain proxy failure after classified direct-connect blocks implicit fetch', async () => {
  const { repo } = fakeBackoffs()
  let fetches = 0
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'u', fallbackList: [{ id: 'direct_connect' }, { id: 'a' }],
    runtimeLocation: 'TEST', proxyById: new Map([['a', proxyA]]),
    runProxied: async () => { throw new ProxyDialError('uncertain proxy failure', 'inner-tls') },
    runDirectFetch: async () => { fetches++; return new Response('fetch') },
    runDirectConnect: async () => { throw classifiedFailure() }, socketDial: () => classifiedSocketDial,
  })
  await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(AggregateError)
  expect(fetches).toBe(0)
})

test('a proxy-only chain has no qualified direct attempt and cannot use implicit fetch', async () => {
  const { repo } = fakeBackoffs()
  let fetches = 0
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'u', fallbackList: [{ id: 'a' }],
    runtimeLocation: 'TEST', proxyById: new Map([['a', proxyA]]),
    runProxied: async () => { throw new ProxyDialError('proxy failed', 'tcp-connect', { cause: workerdFailure }) },
    runDirectFetch: async () => { fetches++; return new Response('fetch') },
    runDirectConnect: async () => { throw new Error('direct must not run') },
    socketDial: () => classifiedSocketDial,
  })
  await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(ProxyDialError)
  expect(fetches).toBe(0)
})

test('configured direct_fetch keeps its order after colo filtering', async () => {
  const { repo } = fakeBackoffs()
  const calls: string[] = []
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'u',
    fallbackList: [{ id: 'direct_fetch', colos: ['LHR'] }, { id: 'direct_connect', colos: ['SJC'] }],
    runtimeLocation: 'SJC', proxyById: new Map(),
    runProxied: async () => new Response('proxy'),
    runDirectFetch: async () => { calls.push('fetch'); return new Response('fetch') },
    runDirectConnect: async () => { calls.push('connect'); throw classifiedFailure() },
    socketDial: () => classifiedSocketDial,
  })
  expect(await (await fetcher('https://api.openai.com', { method: 'GET' })).text()).toBe('fetch')
  expect(calls).toEqual(['connect', 'fetch'])
})

test('implicit fetch replays FormData bytes and matching multipart boundary', async () => {
  const { repo } = fakeBackoffs()
  const form = new FormData()
  form.set('field', 'value')
  let observed: RequestInit | undefined
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'u', fallbackList: [], runtimeLocation: 'TEST', proxyById: new Map(),
    runProxied: async () => new Response('proxy'),
    runDirectFetch: async (_url, init) => { observed = init; return new Response('fetch') },
    runDirectConnect: async () => { throw classifiedFailure() }, socketDial: () => classifiedSocketDial,
  })
  await fetcher('https://api.openai.com', { method: 'POST', body: form })
  expect(observed?.body).toBeInstanceOf(Uint8Array)
  const contentType = new Headers(observed?.headers).get('content-type')
  expect(contentType).toMatch(/^multipart\/form-data; boundary=.+/)
  const boundary = contentType?.split('boundary=')[1]
  expect(new TextDecoder().decode(observed?.body as Uint8Array)).toStartWith(`--${boundary}\r\n`)
})

test.each([400, 503])('implicit fetch %d response is final', async status => {
  const { repo } = fakeBackoffs()
  let fetches = 0
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'u', fallbackList: [], runtimeLocation: 'TEST', proxyById: new Map(),
    runProxied: async () => new Response('proxy'),
    runDirectFetch: async () => { fetches++; return new Response('error', { status }) },
    runDirectConnect: async () => { throw classifiedFailure() }, socketDial: () => classifiedSocketDial,
  })
  expect((await fetcher('https://api.openai.com', { method: 'GET' })).status).toBe(status)
  expect(fetches).toBe(1)
})

test('implicit fetch rejection is final after one attempt', async () => {
  const { repo } = fakeBackoffs()
  const failure = new Error('fetch failed')
  let fetches = 0
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'u', fallbackList: [], runtimeLocation: 'TEST', proxyById: new Map(),
    runProxied: async () => new Response('proxy'),
    runDirectFetch: async () => { fetches++; throw failure },
    runDirectConnect: async () => { throw classifiedFailure() }, socketDial: () => classifiedSocketDial,
  })
  await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBe(failure)
  expect(fetches).toBe(1)
})

test('configured direct_fetch keeps its operator order with no implicit retry', async () => {
  const { repo } = fakeBackoffs()
  const calls: string[] = []
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'u', fallbackList: [{ id: 'direct_connect' }, { id: 'direct_fetch' }],
    runtimeLocation: 'TEST', proxyById: new Map(), runProxied: async () => new Response('proxy'),
    runDirectFetch: async () => { calls.push('fetch'); throw new Error('fetch failed') },
    runDirectConnect: async () => { calls.push('connect'); throw classifiedFailure() },
    socketDial: () => classifiedSocketDial,
  })
  await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(AggregateError)
  expect(calls).toEqual(['connect', 'fetch'])
})

test('ordinary TCP error and inner TLS error do not enable implicit fetch', async () => {
  for (const stage of ['tcp-connect', 'inner-tls'] as const) {
    const { repo } = fakeBackoffs()
    let fetches = 0
    const fetcher = createFetcher({
      proxyBackoffs: repo, upstreamId: 'u', fallbackList: [], runtimeLocation: 'TEST', proxyById: new Map(),
      runProxied: async () => new Response('proxy'), runDirectFetch: async () => { fetches++; return new Response('fetch') },
      runDirectConnect: async () => { throw new ProxyDialError('failed', stage, { cause: new Error('ordinary') }) },
      socketDial: () => classifiedSocketDial,
    })
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(ProxyDialError)
    expect(fetches).toBe(0)
  }
})

test('caller abort after classified rejection prevents implicit fetch', async () => {
  const { repo } = fakeBackoffs()
  const controller = new AbortController()
  let fetches = 0
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'u', fallbackList: [], runtimeLocation: 'TEST', proxyById: new Map(),
    runProxied: async () => new Response('proxy'), runDirectFetch: async () => { fetches++; return new Response('fetch') },
    runDirectConnect: async () => { controller.abort(); throw classifiedFailure() }, socketDial: () => classifiedSocketDial,
  })
  await expect(fetcher('https://api.openai.com', { method: 'GET', signal: controller.signal })).rejects.toThrow()
  expect(fetches).toBe(0)
})

const observedCalls = () => {
  const calls: Array<{ parent: number; upstreamId: string; children: DialAttemptInput[] }> = []
  const errors: string[] = []
  const observer: DialObserver = {
    beginCall({ upstreamId }) {
      const call = { parent: calls.length + 1, upstreamId, children: [] as DialAttemptInput[] }
      calls.push(call)
      return {
        beginAttempt(attempt) {
          call.children.push(attempt)
          return {
            onResponse(response) { return response },
            onFetchError(category) { errors.push(category) },
          }
        },
      }
    },
  }
  return { observer, calls, errors }
}

test('one observed outer call links each actual fallback dispatch in order', async () => {
  const { repo } = fakeBackoffs()
  const { observer, calls, errors } = observedCalls()
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
    runtimeLocation: 'TEST', proxyById: new Map([['a', proxyA]]), observer,
    runProxied: async () => { throw new ProxyDialError('failed', 'tcp-connect') },
    runDirectFetch: async () => new Response('final', { status: 503 }),
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  expect((await fetcher('https://api.openai.com/v1', { method: 'POST', body: '界' })).status).toBe(503)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.upstreamId).toBe('upstream')
  expect(calls[0]?.children.map(child => [child.transport, child.transportId, child.method])).toEqual([
    ['proxy', 'a', 'POST'], ['direct_fetch', 'direct_fetch', 'POST'],
  ])
  expect(calls[0]?.children[0]?.body).toMatchObject({ kind: 'bytes' })
  expect(calls[0]?.children[1]?.body).toMatchObject({ kind: 'bytes' })
  expect(errors).toEqual(['network'])
})

test('backed-off proxy gets a child only when pass two actually dispatches it', async () => {
  const { repo } = fakeBackoffs()
  await repo.recordDialFailure('a', 'upstream', 'old')
  const { observer, calls } = observedCalls()
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'a' }],
    runtimeLocation: 'TEST', proxyById: new Map([['a', proxyA]]), observer,
    runProxied: async () => new Response('pass two'),
    runDirectFetch: async () => new Response('unexpected'),
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  expect(await (await fetcher('https://api.openai.com', { method: 'GET' })).text()).toBe('pass two')
  expect(calls[0]?.children.map(child => child.transportId)).toEqual(['a'])
})

test('separate Fetcher invocations keep separate parent groups', async () => {
  const { repo } = fakeBackoffs()
  const { observer, calls } = observedCalls()
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'direct_fetch' }],
    runtimeLocation: 'TEST', proxyById: new Map(), observer,
    runProxied: async () => new Response('unexpected'),
    runDirectFetch: async () => new Response('ok'),
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  await fetcher('https://api.openai.com/first', { method: 'GET' })
  await fetcher('https://api.openai.com/second', { method: 'POST', body: 'x' })
  expect(calls.map(call => [call.parent, call.children.map(child => child.url)])).toEqual([
    [1, ['https://api.openai.com/first']],
    [2, ['https://api.openai.com/second']],
  ])
})

test('implicit direct fetch is observed after classified direct-connect failure', async () => {
  const { repo } = fakeBackoffs()
  const { observer, calls, errors } = observedCalls()
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [], runtimeLocation: 'TEST',
    proxyById: new Map(), observer,
    runProxied: async () => new Response('unexpected'),
    runDirectFetch: async () => new Response('fallback'),
    runDirectConnect: async () => { throw classifiedFailure() },
    socketDial: () => classifiedSocketDial,
  })
  expect(await (await fetcher('https://api.openai.com', { method: 'GET' })).text()).toBe('fallback')
  expect(calls[0]?.children.map(child => child.transport)).toEqual(['direct_connect', 'direct_fetch'])
  expect(errors).toEqual(['network'])
})

test('pre-dispatch failures do not fabricate transport children', async () => {
  const { repo } = fakeBackoffs()
  const calls: string[] = []
  const observer: DialObserver = { beginCall() { return {
    onPreDispatchFailure(category) { calls.push(category) },
    beginAttempt() { calls.push('child'); return undefined },
  } } }
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'missing' }],
    runtimeLocation: 'TEST', proxyById: new Map(), observer,
    runProxied: async () => new Response('unexpected'),
    runDirectFetch: async () => new Response('unexpected'),
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toThrow()
  expect(calls).toEqual(['config'])
})

test('observer failures cannot change fallback, abort, or proxy backoff', async () => {
  const { repo } = fakeBackoffs()
  const observer: DialObserver = { beginCall() { return {
    beginAttempt() { throw new ProxyDialError('observer failed', 'tcp-connect') },
  } } }
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
    runtimeLocation: 'TEST', proxyById: new Map([['a', proxyA]]), observer,
    runProxied: async () => new Response('proxy succeeded'),
    runDirectFetch: async () => new Response('unexpected'),
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  expect(await (await fetcher('https://api.openai.com', { method: 'GET' })).text()).toBe('proxy succeeded')
  expect(await repo.listForUpstream('upstream')).toEqual([])
})

test('observer sees direct native text without forcing a body read', async () => {
  const { repo } = fakeBackoffs()
  const { observer, calls } = observedCalls()
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'direct_fetch' }],
    runtimeLocation: 'TEST', proxyById: new Map(), observer,
    runProxied: async () => new Response('unexpected'),
    runDirectFetch: async () => new Response(null, { status: 204 }),
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  expect((await fetcher('https://api.openai.com', { method: 'POST', body: '界'.repeat(30000) })).status).toBe(204)
  expect(calls[0]?.children[0]?.body).toEqual({ kind: 'text', text: '界'.repeat(30000) })
})

test('a throwing observer callback getter cannot replace a healthy response', async () => {
  const { repo } = fakeBackoffs()
  const call = Object.defineProperty({}, 'beginAttempt', {
    get() { throw new ProxyDialError('callback lookup failed', 'tcp-connect') },
  })
  const observer: DialObserver = { beginCall: () => call }
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'a' }],
    runtimeLocation: 'TEST', proxyById: new Map([['a', proxyA]]), observer,
    runProxied: async () => new Response('healthy'),
    runDirectFetch: async () => new Response('unexpected'),
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  expect(await (await fetcher('https://api.openai.com', { method: 'GET' })).text()).toBe('healthy')
  expect(await repo.listForUpstream('upstream')).toEqual([])
})

test('a response callback failure leaves HTTP status and body available', async () => {
  const { repo } = fakeBackoffs()
  const original = new Response('rate limit', { status: 429, headers: { 'retry-after': '7' } })
  const observer: DialObserver = { beginCall: () => ({
    beginAttempt: () => ({ onResponse() { throw new Error('capture failed') } }),
  }) }
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'direct_fetch' }],
    runtimeLocation: 'TEST', proxyById: new Map(), observer,
    runProxied: async () => new Response('unexpected'),
    runDirectFetch: async () => original,
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  const response = await fetcher('https://api.openai.com', { method: 'GET' })
  expect(response).toBe(original)
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('7')
  expect(await response.text()).toBe('rate limit')
})

test('an error callback failure cannot change abort propagation', async () => {
  const { repo } = fakeBackoffs()
  const abort = new DOMException('stopped', 'AbortError')
  let laterFetches = 0
  const observer: DialObserver = { beginCall: () => ({
    beginAttempt: () => ({ onFetchError() { throw new Error('callback failed') } }),
  }) }
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
    runtimeLocation: 'TEST', proxyById: new Map([['a', proxyA]]), observer,
    runProxied: async () => { throw abort },
    runDirectFetch: async () => { laterFetches += 1; return new Response('unexpected') },
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBe(abort)
  expect(laterFetches).toBe(0)
})

test('inherited RequestInit values are not misreported as default method and empty body', async () => {
  const { repo } = fakeBackoffs()
  const { observer, calls } = observedCalls()
  const init = Object.create({ method: 'POST', body: 'inherited text' }) as RequestInit
  const runtimeRequest = new Request('https://example.com', init)
  expect(runtimeRequest.method).toBe('POST')
  expect(await runtimeRequest.text()).toBe('inherited text')
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'direct_fetch' }],
    runtimeLocation: 'TEST', proxyById: new Map(), observer,
    runProxied: async () => new Response('unexpected'),
    runDirectFetch: async () => new Response('ok'),
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  await fetcher('https://example.com', init)
  expect(calls[0]?.children[0]?.method).toBe('unknown')
  expect(calls[0]?.children[0]?.body).toEqual({ kind: 'unobserved' })
})

test('an observed error response is not read or locked before its consumer cancels it', async () => {
  const { repo } = fakeBackoffs()
  let pulls = 0
  let cancellations = 0
  let seenStatus: number | undefined
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulls += 1; controller.enqueue(Uint8Array.of(1)) },
    cancel() { cancellations += 1 },
  }, { highWaterMark: 0 })
  const observer: DialObserver = { beginCall: () => ({
    beginAttempt: () => ({ onResponse(response) { seenStatus = response.status; return response } }),
  }) }
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'direct_fetch' }],
    runtimeLocation: 'TEST', proxyById: new Map(), observer,
    runProxied: async () => new Response('unexpected'),
    runDirectFetch: async () => new Response(body, { status: 429 }),
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  const response = await fetcher('https://api.openai.com', { method: 'GET' })
  expect(seenStatus).toBe(429)
  expect(pulls).toBe(0)
  expect(response.body?.locked).toBe(false)
  await response.body?.cancel('discard')
  expect(pulls).toBe(0)
  expect(cancellations).toBe(1)
})

test('no-body responses still notify the transport child', async () => {
  const { repo } = fakeBackoffs()
  let status: number | undefined
  const observer: DialObserver = { beginCall: () => ({
    beginAttempt: () => ({ onResponse(response) { status = response.status; return response } }),
  }) }
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'direct_fetch' }],
    runtimeLocation: 'TEST', proxyById: new Map(), observer,
    runProxied: async () => new Response('unexpected'),
    runDirectFetch: async () => new Response(null, { status: 204 }),
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  const response = await fetcher('https://api.openai.com', { method: 'GET' })
  expect(status).toBe(204)
  expect(response.body).toBeNull()
})

test('without an observer the original Response is returned unchanged', async () => {
  const { repo } = fakeBackoffs()
  const original = new Response('ok')
  const fetcher = createFetcher({
    proxyBackoffs: repo, upstreamId: 'upstream', fallbackList: [{ id: 'direct_fetch' }],
    runtimeLocation: 'TEST', proxyById: new Map(),
    runProxied: async () => new Response('unexpected'),
    runDirectFetch: async () => original,
    runDirectConnect: okDirectConnect, socketDial: () => stubSocketDial,
  })
  expect(await fetcher('https://api.openai.com', { method: 'GET' })).toBe(original)
})
