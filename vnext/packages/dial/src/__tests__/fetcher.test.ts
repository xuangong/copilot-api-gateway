/**
 * Dial-chain behaviour. Ported from copilot-gateway's
 * packages/gateway/__tests__/dial/fetcher_test.ts, trimmed to the cases that
 * pin the semantics the gateway relies on: two-pass ordering, backoff
 * bookkeeping, the implicit direct-connect default, and body replay.
 */
import { test, expect } from 'bun:test'
import { createFetcher } from '../fetcher.ts'
import type { ProxyEntry } from '../proxy-catalog.ts'
import { ProxyDialError, type ProxyConfig, type SocketDial } from '@vibe-core/proxy'
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
