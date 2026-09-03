/**
 * sessionAuthMiddleware's Copilot pre-warm block — egress transport.
 *
 * The block (control-plane/auth/session-auth.ts) looks up the session user's
 * enabled `copilot` upstream, resolves that upstream's proxy fallback chain
 * into a Fetcher, and passes the Fetcher into `getCachedCopilotToken` so the
 * GitHub -> Copilot token exchange leaves the host through the proxy. These
 * tests pin the caller half of that contract; `copilot-token-cache.test.ts`
 * already pins the callee half ("getCachedCopilotToken forwards the fetcher to
 * the exchange").
 *
 * Real BunSqliteRepo throughout — the resolver reads the upstream row and the
 * `proxies` table, so a hand-written fake would prove nothing about that
 * plumbing. mock.module() is not used: it leaks across test files in Bun 1.3.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { __resetPlatformForTests, initRuntimeLocation, initSocketDial } from '@vibe-core/platform'
import { initRepo, type UpstreamRecord } from '../src/repo/index.ts'
import type { ProxyFallbackEntry } from '@vibe-core/proxy-repo'
import type { SessionToken, UpstreamId, UserId } from '../src/repo/branded-ids.ts'
import { sessionAuthMiddleware } from '../src/control-plane/auth/session-auth.ts'
import { realFetch, stubGlobalFetch } from './_stub-global-fetch.ts'

const OWNER = 'u1' as UserId
const NOW = '2026-01-01T00:00:00.000Z'
const FAR_FUTURE = '2099-01-01T00:00:00.000Z'
const UPSTREAM_ID = 'up_copilot_prewarm' as UpstreamId

let repo: SqliteRepo
/** Every URL the ambient global fetch was asked for during a test. */
let globalFetchUrls: string[]
/** Every (host, port) the platform SocketDial was asked to connect to. */
let dials: Array<{ host: string; port: number }>

beforeEach(() => {
  // initRepo / initRuntimeLocation / initSocketDial all write process-global
  // state that Bun carries across test files in one process; reset first so
  // this file neither inherits nor leaks a platform singleton. The pre-warm
  // block calls getRuntimeLocation(), so one must be set for every test.
  __resetPlatformForTests()
  repo = new SqliteRepo(new Database(':memory:'))
  initRepo(repo)
  initRuntimeLocation('bun')

  dials = []
  // The dialer obtains this via `getSocketDial()` at attempt time, and the
  // platform reset in afterEach clears it again (packages/platform/src/
  // socket-dial.ts registers its own reset hook). Recording then throwing keeps
  // the test fully offline: no packet leaves the process, so the proxy address
  // below is never contacted and nothing depends on 127.0.0.1:1 being closed.
  initSocketDial({
    connect: async (host: string, port: number) => {
      dials.push({ host, port })
      throw new Error('refused by test SocketDial')
    },
  })

  globalFetchUrls = []
  // Answers the token exchange with a valid, far-future session so that a call
  // which *does* reach the ambient fetch succeeds visibly (ctx.copilot set)
  // rather than failing for an unrelated reason.
  stubGlobalFetch(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    globalFetchUrls.push(url)
    return Response.json({
      token: 'copilot_session_from_global_fetch',
      expires_at: Math.floor(Date.parse(FAR_FUTURE) / 1000),
      refresh_in: 1500,
    })
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  __resetPlatformForTests()
})

/**
 * A Copilot upstream owned by OWNER. `githubToken` is unique per test because
 * `getCachedCopilotToken` keys its in-process cache on
 * sha256(githubHost:accountType:githubToken) and returns a fresh entry before
 * touching the fetcher at all (copilot-token-cache.ts, the isFresh check just
 * above the exchange). A shared token would let one test's cached session make
 * the next one pass without any egress.
 */
async function saveCopilotUpstream(
  githubToken: string,
  chain: ProxyFallbackEntry[],
): Promise<void> {
  const row: UpstreamRecord = {
    id: UPSTREAM_ID,
    ownerId: OWNER,
    provider: 'copilot',
    name: 'prewarm',
    enabled: true,
    sortOrder: 0,
    config: { githubToken, accountType: 'individual' },
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    proxyFallbackList: chain,
    createdAt: NOW,
    updatedAt: NOW,
  }
  await repo.upstreams.save(row)
}

/**
 * Only the slice of the middleware's auth context these tests read back. The
 * middleware writes the full FullAuthCtx (session-auth.ts); this narrower shape
 * is all the probe route needs to answer "did the pre-warm succeed?".
 */
type ProbeVars = {
  auth?: {
    userId?: UserId
    apiKeyId?: string
    authKind?: 'apiKey' | 'session'
    routingPolicy?: { modelMappingsEnabled: boolean; modelMappings: readonly { source: string; destination: string }[] }
    copilot?: { copilotToken: string }
  }
}

/**
 * A live session for OWNER, plus the app under test. The `ses_` prefix selects
 * the session branch of the middleware, which is one of the paths that sets
 * `resolvedUserId` — the pre-warm block only runs when that is set.
 */
async function buildApp(): Promise<Hono<{ Variables: ProbeVars }>> {
  await repo.users.create({
    id: OWNER,
    name: 'Alice',
    createdAt: NOW,
    disabled: false,
  })
  await repo.sessions.create({
    token: 'ses_prewarm' as SessionToken,
    userId: OWNER,
    createdAt: NOW,
    expiresAt: FAR_FUTURE,
  })

  const app = new Hono<{ Variables: ProbeVars }>()
  app.use('*', sessionAuthMiddleware)
  app.get('/probe', (c) => {
    const auth = c.get('auth')
    return c.json({ copilotToken: auth?.copilot?.copilotToken ?? null })
  })
  return app
}

async function buildOwnerlessApiKeyApp(): Promise<Hono<{ Variables: ProbeVars }>> {
  await repo.apiKeys.save({
    id: 'key_ownerless',
    name: 'ownerless',
    key: 'ownerless_api_key',
    createdAt: NOW,
    modelMappingsEnabled: true,
    modelMappings: [{ source: 'gpt-5.6-sol', destination: 'gpt-5.6-sol-fast' }],
  })

  const app = new Hono<{ Variables: ProbeVars }>()
  app.use('*', sessionAuthMiddleware)
  app.get('/probe', (c) => c.json(c.get('auth') ?? null))
  return app
}

function request(app: Hono<{ Variables: ProbeVars }>): Promise<Response> {
  return app.request('/probe', { headers: { cookie: 'session_token=ses_prewarm' } })
}

/**
 * The token exchange must travel through the fetcher resolved from the
 * upstream's chain, not through the ambient global fetch.
 *
 * The oracle is the SocketDial stub, because the middleware itself tells us
 * nothing: the whole pre-warm block sits in a `try { } catch { }` that swallows
 * every failure, so status and body are identical either way. Three independent
 * observations, all only explicable by the exchange having gone through the
 * resolved fetcher:
 *   - `dials` is non-empty, at the proxy's address — nothing else on this
 *     request opens a socket; the global fetch here is a stub that returns a
 *     Response without dialling.
 *   - `globalFetchUrls` is empty — that stub records every URL it is asked for.
 *   - `copilotToken` is null — that stub answers the exchange with a valid
 *     session, so a call that reached it would populate ctx.copilot.
 *
 * Verified by mutation: dropping the `fetcher` argument from the
 * `getCachedCopilotToken(...)` call in session-auth.ts fails this test, and
 * each of the three assertions below detects it on its own (checked separately,
 * one at a time).
 */
test('an ownerless API key attaches only its safe routing auth context without pre-warming', async () => {
  const app = await buildOwnerlessApiKeyApp()
  const res = await app.request('/probe', { headers: { 'x-api-key': 'ownerless_api_key' } })

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    apiKeyId: 'key_ownerless',
    authKind: 'apiKey',
    isUser: false,
    routingPolicy: {
      modelMappingsEnabled: true,
      modelMappings: [{ source: 'gpt-5.6-sol', destination: 'gpt-5.6-sol-fast' }],
    },
  })
  expect(globalFetchUrls).toEqual([])
  expect(dials).toEqual([])
})

test('a saved chain sends the copilot pre-warm exchange through the resolved fetcher', async () => {
  // `insert` is the ProxyRepo's own writer, so the row is genuine SQLite state
  // that loadProxyCatalog reads back through the real column/JSON plumbing.
  await repo.proxies.insert({
    id: 'px_local',
    name: 'local',
    url: 'http://127.0.0.1:1',
    dialTimeoutSeconds: null,
  })
  await saveCopilotUpstream('gh_token_chained', [{ id: 'px_local' }])

  const res = await request(await buildApp())
  // The swallow makes the response uninformative on purpose; asserted only to
  // show the request completed rather than hanging or 500ing.
  expect(res.status).toBe(200)
  const body = (await res.json()) as { copilotToken: string | null }

  expect(dials.length).toBeGreaterThan(0)
  for (const d of dials) expect(d).toEqual({ host: '127.0.0.1', port: 1 })
  expect(globalFetchUrls).toEqual([])
  expect(body.copilotToken).toBeNull()
})

/**
 * The complement: with no chain, `resolveControlPlaneFetcher` returns undefined
 * ("keep the caller's default"), and the exchange succeeds against the stub.
 *
 * This case does not discriminate the fetcher argument from its absence —
 * session-auth.ts passes the resolver's return value straight through, so with
 * no chain the argument *is* `undefined`, and it is `getCachedCopilotToken`'s
 * own parameter default (`fetcher: Fetcher = fetch`, copilot-token-cache.ts)
 * that supplies the global fetch either way. So it is not that mutation's
 * killer. What it pins is the empty-chain branch of the resolver itself:
 * collapsing an empty chain to a built-in transport (as packages/dial/src/
 * fetcher.ts does for its own empty `fallbackList`) would dial through the
 * refusing stub instead of reaching the global fetch. Verified by mutation:
 * returning `buildOverrideFetcher([{ id: 'direct_connect' }], …)` instead of
 * `undefined` from that branch (proxy-resolution.ts) fails this test on
 * `copilotToken` (received null), while the first test still passes.
 */
test('an upstream without a chain pre-warms over the global fetch (no dial)', async () => {
  await saveCopilotUpstream('gh_token_direct', [])

  const res = await request(await buildApp())
  expect(res.status).toBe(200)
  const body = (await res.json()) as { copilotToken: string | null }

  expect(body.copilotToken).toBe('copilot_session_from_global_fetch')
  expect(globalFetchUrls).toEqual(['https://api.github.com/copilot_internal/v2/token'])
  expect(dials).toEqual([])
})
