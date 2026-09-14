import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index.ts"
import type { SessionToken, UserId } from "../src/repo/branded-ids.ts"
import { app } from "../src/app.ts"
import { setGoogleFetcherForTest } from "../src/control-plane/auth/google-routes.ts"
import { resetAuthStoresForTest } from "../src/control-plane/auth/stores.ts"

let db: Database
let repo: BunSqliteRepo
const token = "ses_synthetic_old_login" as SessionToken
const subject = "reauth-user" as UserId
const origin = "https://gateway.example"
const challenge = "n".repeat(43)
const env = { GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-secret" }
let exchanges: number
beforeEach(async () => {
  __resetPlatformForTests()
  resetAuthStoresForTest()
  const config: Record<string, string> = { AGENT_REMOTE_RELAY_URL: "https://relay.example", AGENT_REMOTE_ISSUER: origin, AGENT_REMOTE_SIGNING_SECRET: "synthetic-agent-remote-secret-0123456789" }
  initEnv(name => config[name] ?? "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  await repo.users.create({ id: subject, name: "Synthetic", email: "synthetic@example.com", createdAt: new Date().toISOString(), disabled: false })
  await repo.sessions.create({ token, userId: subject, createdAt: new Date(Date.now() - 3600_000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() })
  exchanges = 0
  setGoogleFetcherForTest(async input => {
    exchanges++
    return Response.json(String(input).includes("/token") ? { access_token: "synthetic-oauth-token" } : { email: "synthetic@example.com", name: "Synthetic" })
  })
})
afterEach(() => { db.close(); setGoogleFetcherForTest(null); resetAuthStoresForTest(); __resetPlatformForTests() })
async function start() {
  const entry = await app.request(`${origin}/agent-remote?reauthenticate=1&challenge=${challenge}&host=host_1`, { headers: { cookie: `session_token=${token}` } }, env)
  expect(entry.status).toBe(303)
  const location = new URL(entry.headers.get("location") ?? "", origin)
  expect(location.origin).toBe(origin)
  expect(location.pathname).toBe("/auth/google")
  const response = await app.request(location.href, {}, env)
  expect(response.status).toBe(302)
  const google = new URL(response.headers.get("location") ?? "")
  expect(google.origin).toBe("https://accounts.google.com")
  return { state: google.searchParams.get("state"), cookie: response.headers.getSetCookie().find(value => value.startsWith("agent_remote_oauth="))?.split(";")[0] ?? "" }
}

test("reauthentication requires browser-bound OAuth and returns to the validated launch target", async () => {
  const { state, cookie } = await start()
  expect(cookie).toMatch(/^agent_remote_oauth=/)
  expect(exchanges).toBe(0)
  const response = await app.request(`${origin}/auth/google/callback?code=synthetic&state=${state}`, { headers: { cookie } }, env)
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(`/agent-remote?challenge=${challenge}&host=host_1`)
  expect(exchanges).toBe(2)
  const created = db.query<{ created_at: string }, []>("SELECT created_at FROM user_sessions ORDER BY created_at DESC LIMIT 1").get()
  expect(Date.parse(created?.created_at ?? "")).toBeGreaterThan(Date.now() - 5000)
  expect((await app.request(`${origin}/auth/google/callback?code=synthetic&state=${state}`, { headers: { cookie } }, env)).status).toBe(400)
}, 5000)

test("existing login cookie cannot substitute for reauthentication browser binding", async () => {
  const { state } = await start()
  const response = await app.request(`${origin}/auth/google/callback?code=synthetic&state=${state}`, { headers: { cookie: `session_token=${token}` } }, env)
  expect(response.status).toBe(400)
  expect(exchanges).toBe(0)
}, 5000)

test("reauthentication cannot carry an external or malformed return target", async () => {
  for (const returnTo of ["https://evil.example", "//evil.example", "/dashboard", "/agent-remote?host=%22evil", "/agent-remote?reauthenticate=1", "/agent-remote?challenge=invalid"]) {
    const response = await app.request(`${origin}/auth/google?agent_remote_return=${encodeURIComponent(returnTo)}`, {}, env)
    expect(response.status).toBe(400)
  }
  expect(exchanges).toBe(0)
}, 5000)

test("authentication initiation is rate limited before storing more challenges", async () => {
  const target = `${origin}/auth/google?agent_remote_return=${encodeURIComponent('/agent-remote')}`
  for (let index = 0; index < 20; index++) expect((await app.request(target, { headers: { 'cf-connecting-ip': '192.0.2.40' } }, env)).status).toBe(302)
  const response = await app.request(target, { headers: { 'cf-connecting-ip': '192.0.2.40' } }, env)
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('60')
  expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM agent_remote_oauth_states').get()?.count).toBe(20)
}, 5000)

test("Agents OAuth pins its redirect URI to the configured Gateway origin", async () => {
  const target = `${origin}/auth/google?agent_remote_return=${encodeURIComponent('/agent-remote')}`
  const response = await app.request(target, { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } }, env)
  expect(response.status).toBe(302)
  expect(new URL(response.headers.get('location') ?? '').searchParams.get('redirect_uri')).toBe(`${origin}/auth/google/callback`)
  expect(response.headers.getSetCookie().join(';')).toContain('Secure')
}, 5000)

test("expired and concurrently replayed browser challenges cannot create extra sessions", async () => {
  const first = await start()
  db.query("UPDATE agent_remote_oauth_states SET expires_at = ?").run(Date.now() - 1)
  expect((await app.request(`${origin}/auth/google/callback?code=synthetic&state=${first.state}`, { headers: { cookie: first.cookie } }, env)).status).toBe(400)
  expect(exchanges).toBe(0)
  const next = await start()
  const callback = () => app.request(`${origin}/auth/google/callback?code=synthetic&state=${next.state}`, { headers: { cookie: next.cookie } }, env)
  const results = await Promise.all([callback(), callback()])
  expect(results.map(value => value.status).sort()).toEqual([302, 400])
  expect(exchanges).toBe(2)
}, 5000)
