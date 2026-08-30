/**
 * The dashboard cannot tell that an sdf upstream's Substrate token has expired:
 * `redactConfig` replaces every token-shaped config key with '***' before the
 * record is serialised, so the browser never sees the JWT. The server therefore
 * decodes `exp` itself and ships the verdict as its own field, `tokenExpiredAt`.
 *
 * That existed because a 401 from Substrate reads `LLM API: Unauthorized
 * access` — indistinguishable from a permission or model problem — while the
 * real cause (an `exp` 38 hours in the past) was sitting in plaintext inside the
 * token the whole time. base64url is an encoding, not encryption.
 *
 * These tests pin the two halves that are easy to break together: that the
 * field appears exactly when the token is dead, and that computing it did not
 * disturb the redaction it has to run before. The field is a hint for a human
 * and never gates dispatch, so nothing here asserts routing behaviour.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/repo/index.ts'
import { __resetPlatformForTests, initRuntimeLocation } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../src/repo/types.ts'
import { upstreamsRouter, type AuthCtx } from '../src/control-plane/upstreams/routes.ts'

/** An unsigned JWT carrying exactly these claims. Only the payload is ever read. */
function jwt(claims: Record<string, unknown>): string {
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.sig`
}

const HOUR = 3600
const nowSec = () => Math.floor(Date.now() / 1000)

function inMemoryRepo() {
  const upstreams = new Map<string, UpstreamRecord>()
  return {
    upstreams,
    repo: {
      upstreams: {
        list: async () => [...upstreams.values()],
        getById: async (id: string) => upstreams.get(id) ?? null,
        save: async (u: UpstreamRecord) => { upstreams.set(u.id, u) },
        delete: async (id: string) => upstreams.delete(id),
        deleteAll: async () => { upstreams.clear() },
      },
    } as unknown as Repo,
  }
}

function upstream(over: Partial<UpstreamRecord> = {}): UpstreamRecord {
  const now = new Date().toISOString()
  return {
    id: 'up_sdf_test_0001',
    ownerId: 'u_1',
    provider: 'sdf',
    name: 'substrate',
    enabled: true,
    sortOrder: 0,
    config: {},
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  } as UpstreamRecord
}

function buildApp(auth: AuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api/upstreams', upstreamsRouter)
  return app
}

let store: ReturnType<typeof inMemoryRepo>

beforeEach(() => {
  __resetPlatformForTests()
  store = inMemoryRepo()
  initRepo(store.repo)
  initRuntimeLocation('bun')
})

/** Serialise one upstream through the real list route. */
async function serve(u: UpstreamRecord) {
  store.upstreams.set(u.id, u)
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams?includeDisabled=1')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { upstreams: Array<Record<string, unknown>> }
  return body.upstreams[0]!
}

test('an sdf token whose exp has passed is reported, down to the second', async () => {
  const exp = nowSec() - 38 * HOUR
  const row = await serve(upstream({ config: { substrateToken: jwt({ exp, tid: 'acme' }) } }))
  expect(row.tokenExpiredAt).toBe(new Date(exp * 1000).toISOString())
})

test('an sdf token that is still in date carries no field at all', async () => {
  // Absence, not `false` — there is no third state to encode, and a caller
  // testing truthiness must not be able to trip over `expired: false`.
  const row = await serve(upstream({ config: { substrateToken: jwt({ exp: nowSec() + HOUR }) } }))
  expect(row).not.toHaveProperty('tokenExpiredAt')
})

test('a token with no exp claim is left alone rather than assumed dead', async () => {
  // Unknown is not expired. Flagging it would train the operator to ignore red.
  const row = await serve(upstream({ config: { substrateToken: jwt({ tid: 'acme' }) } }))
  expect(row).not.toHaveProperty('tokenExpiredAt')
})

test('a credential that is not a JWT at all does not blow up the list route', async () => {
  // The whole upstream list is one bad `atob` away from a 500 if this throws.
  for (const token of ['not-a-jwt', 'a.b', 'a.!!!!.c', '']) {
    const row = await serve(upstream({ config: { substrateToken: token } }))
    expect(row).not.toHaveProperty('tokenExpiredAt')
  }
})

test('a non-sdf upstream is never checked, even holding a long-dead JWT', async () => {
  // Scope is deliberate: only substrateToken is known to be a JWT we issued
  // ourselves. A copilot OAuth token or an azure apiKey that happens to decode
  // would produce a verdict we have no basis for.
  const row = await serve(
    upstream({
      provider: 'custom',
      config: { apiKey: jwt({ exp: nowSec() - HOUR }) },
    }),
  )
  expect(row).not.toHaveProperty('tokenExpiredAt')
})

test('reading the token to date it does not leak it into the response', async () => {
  // The expiry check runs on the raw config; redaction runs after. Reverse the
  // two and this test still passes while the check silently reads '***' — so
  // assert both halves, here and in the first test above.
  const row = await serve(upstream({ config: { substrateToken: jwt({ exp: nowSec() - HOUR }) } }))
  expect((row.config as Record<string, unknown>).substrateToken).toBe('***')
  expect(row.tokenExpiredAt).toBeString()
})
