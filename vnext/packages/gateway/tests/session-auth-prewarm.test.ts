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
type ProbeVars = { auth?: { copilot?: { copilotToken: string } } }

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

function request(app: Hono<{ Variables: ProbeVars }>): Promise<Response> {
  return app.request('/probe', { headers: { cookie: 'session_token=ses_prewarm' } })
}

/**
 * The token exchange must travel through the fetcher resolved from the
 * upstream's chain, not through the ambient global fetch.
 *
 * The oracle is the SocketDial stub, because the middleware itself tells us
 * nothing: the whole pre-warm block sits in a `try { } catch { }` that swallows
 * every failure, so status and body are identical either way. Two independent
 * observations, both only reachable through the resolved fetcher:
 *   - `dials` is non-empty — nothing else on this request opens a socket; the
 *     global fetch here is a stub that returns a Response without dialling.
 *   - `copilotToken` is null — that stub answers the exchange with a valid
 *     session, so a call that reached it would populate ctx.copilot.
 *
 * Verified by mutation: dropping the `fetcher` argument from the
 * `getCachedCopilotToken(...)` call in session-auth.ts fails this test, and
 * each of the two assertion groups below detects it on its own.
 */
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
 * ("keep the caller's default"), `getCachedCopilotToken`'s `fetcher` parameter
 * defaults to the global fetch, and the exchange succeeds against the stub.
 *
 * This case does not discriminate the fetcher argument from its default — with
 * no chain the two are the same function — so it is not the mutation's killer.
 * What it pins is that the pre-warm block genuinely runs and populates
 * ctx.copilot for this fixture, which is what stops the first test's
 * `copilotToken === null` from passing vacuously.
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
