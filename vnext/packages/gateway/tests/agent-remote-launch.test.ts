import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { __resetPlatformForTests, initEnv } from '@vibe-core/platform'
import { initRepo } from '../src/repo/index.ts'
import type { SessionToken, UserId } from '../src/repo/branded-ids.ts'
import { app } from '../src/app.ts'

let db: Database
let repo: BunSqliteRepo
const userId = 'relay-user' as UserId
const sessionToken = 'ses_relay_test' as SessionToken
const config: Record<string, string> = {
  AGENT_REMOTE_RELAY_URL: 'https://relay.example',
  AGENT_REMOTE_ISSUER: 'https://gateway.example',
  AGENT_REMOTE_SIGNING_SECRET: 'test-only-32-byte-secret-value-0123456789',
}
beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(name => config[name] ?? '')
  db = new Database(':memory:')
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  await repo.users.create({ id: userId, name: 'Relay User', createdAt: new Date().toISOString(), disabled: false })
  await repo.sessions.create({ token: sessionToken, userId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() })
})
afterEach(() => { db.close(); __resetPlatformForTests() })
function launch(headers: Record<string, string> = {}, body = JSON.stringify({ challenge: 'n'.repeat(43) })) {
  return app.request('https://gateway.example/api/agent-remote/launch', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  })
}
test('an active user session receives a signed grant limited to the configured relay', async () => {
  const response = await launch({ cookie: `session_token=${sessionToken}`, origin: 'https://gateway.example' })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const result = await response.json() as { launchUrl: string }
  const url = new URL(result.launchUrl)
  expect(url.origin + url.pathname).toBe('https://relay.example/auth/callback')
  expect(url.search).toBe('')
  const ticket = new URLSearchParams(url.hash.slice(1)).get('ticket') ?? ''
  const [header, payload, signature] = ticket.split('.')
  expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'arc-relay+jwt' })
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<string, unknown>
  expect(claims).toMatchObject({ sub: userId, nonce: 'n'.repeat(43), iss: 'https://gateway.example', aud: 'https://relay.example' })
  expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(900)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.AGENT_REMOTE_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  expect(await crypto.subtle.verify('HMAC', key, Buffer.from(signature ?? '', 'base64url'), new TextEncoder().encode(`${header}.${payload}`))).toBe(true)
  expect(ticket).not.toContain(sessionToken)
}, 5000)
test('missing credentials, query credentials and LLM keys cannot control a workstation', async () => {
  expect((await launch()).status).toBe(401)
  expect((await launch({ authorization: 'Bearer not-a-user-session' })).status).toBe(401)
  expect((await app.request(`https://gateway.example/api/agent-remote/launch?key=${sessionToken}`, { method: 'POST' })).status).toBe(401)
}, 5000)
test('disabled and expired users cannot receive new grants', async () => {
  await repo.users.update(userId, { disabled: true })
  expect((await launch({ authorization: `Bearer ${sessionToken}` })).status).toBe(401)
  await repo.users.update(userId, { disabled: false })
  await repo.sessions.deleteByUserId(userId)
  await repo.sessions.create({ token: sessionToken, userId, createdAt: '2020-01-01', expiresAt: '2020-01-02' })
  expect((await launch({ authorization: `Bearer ${sessionToken}` })).status).toBe(401)
}, 5000)
test('foreign origins and caller selected redirect targets are rejected', async () => {
  expect((await launch({ cookie: `session_token=${sessionToken}`, origin: 'https://evil.example' })).status).toBe(403)
  expect((await launch({ authorization: `Bearer ${sessionToken}` }, '{"relayUrl":"https://evil.example"}')).status).toBe(400)
}, 5000)
test('gateway offers a same-origin launch form and preserves the fixed redirect', async () => {
  const page = await app.request('https://gateway.example/agent-remote?challenge=' + 'n'.repeat(43), { headers: { cookie: `session_token=${sessionToken}` } })
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('/api/agent-remote/launch')
  const response = await app.request('https://gateway.example/api/agent-remote/launch', {
    method: 'POST', headers: { cookie: `session_token=${sessionToken}`, origin: 'https://gateway.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'challenge=' + 'n'.repeat(43),
  })
  expect(response.status).toBe(303)
  expect(response.headers.get('location')).toStartWith('https://relay.example/auth/callback#ticket=')
}, 5000)
test('does not grant more lifetime than the login session and requires cookie Origin', async () => {
  await repo.sessions.deleteByUserId(userId)
  const expires = Math.floor(Date.now() / 1000) + 120
  await repo.sessions.create({ token: sessionToken, userId, createdAt: new Date().toISOString(), expiresAt: new Date(expires * 1000).toISOString() })
  expect((await launch({ cookie: `session_token=${sessionToken}` })).status).toBe(403)
  const response = await launch({ authorization: `Bearer ${sessionToken}` })
  const result = await response.json() as { launchUrl: string }
  const payload = new URLSearchParams(new URL(result.launchUrl).hash.slice(1)).get('ticket')?.split('.')[1] ?? ''
  expect((JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number }).exp).toBe(expires)
}, 5000)

test('selected Host survives login redirect, auto-submit form and signed callback', async () => {
  const headers = { cookie: `session_token=${sessionToken}` }
  const start = await app.request('https://gateway.example/agent-remote?host=host_1', { headers })
  expect(start.headers.get('location')).toBe('https://relay.example/auth/login?host=host_1')
  const page = await app.request('https://gateway.example/agent-remote?host=host_1&challenge=' + 'n'.repeat(43), { headers })
  expect(await page.text()).toContain('name="host" value="host_1"')
  const response = await launch({ authorization: `Bearer ${sessionToken}` }, JSON.stringify({ challenge: 'n'.repeat(43), host: 'host_1' }))
  expect(response.status).toBe(200)
  const result = await response.json() as { launchUrl: string }
  expect(result.launchUrl).toStartWith('https://relay.example/auth/callback?host=host_1#ticket=')
  expect((await launch({ authorization: `Bearer ${sessionToken}` }, JSON.stringify({ challenge: 'n'.repeat(43), host: 'https://evil.example' }))).status).toBe(400)
  expect((await app.request('https://gateway.example/agent-remote?host=%22%3E', { headers })).status).toBe(400)
}, 5000)
