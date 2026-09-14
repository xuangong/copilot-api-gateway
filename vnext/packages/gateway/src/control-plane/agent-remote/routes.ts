import { remoteRateAllowed, remoteSecurityEvent } from "./security.ts"
import { agentRemoteReturnPath } from "./reauthentication.ts"
import { getRepo } from "../../repo/index.ts"
import { Hono } from 'hono'
import { agentRemoteConfiguration as configuration } from './config.ts'
import { agentRemoteLifecycleRouter, continuationHash } from './lifecycle.ts'
import { userSession } from "./user-session.ts"
import { agentRemoteControlRouter, validHostId } from "./control.ts"

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

export const agentRemoteRouter = new Hono()
agentRemoteRouter.use('/agent-remote', secureResponse)
agentRemoteRouter.use('/api/agent-remote/*', secureResponse)
agentRemoteRouter.route('/', agentRemoteLifecycleRouter)
agentRemoteRouter.route('/', agentRemoteControlRouter)
agentRemoteRouter.get('/api/agent-remote/config', c => {
  try { return c.json({ enabled: Boolean(configuration()) }) }
  catch { return c.json({ enabled: false }) }
})
async function secureResponse(c: import('hono').Context, next: import('hono').Next) {
  c.header('cache-control', 'no-store')
  c.header('referrer-policy', 'no-referrer')
  await next()
}
agentRemoteRouter.get('/agent-remote', async c => {
  // A no-referrer document makes browser form POSTs carry an opaque Origin.
  c.header('referrer-policy', 'same-origin')
  const config = configuration()
  if (!config) return c.json({ error: 'Agent Remote is not configured' }, 503)
  const reauthenticate = c.req.query('reauthenticate')
  if (reauthenticate !== undefined) {
    if (reauthenticate !== '1' || c.req.queries('reauthenticate')?.length !== 1) return c.json({ error: 'Invalid reauthentication request' }, 400)
    const target = new URL(c.req.url)
    target.searchParams.delete('reauthenticate')
    const returnPath = agentRemoteReturnPath(target.pathname + target.search)
    if (!returnPath) return c.json({ error: 'Invalid return target' }, 400)
    const loginUrl = new URL('/auth/google', config.issuer)
    loginUrl.searchParams.set('agent_remote_return', returnPath)
    return c.redirect(loginUrl.href, 303)
  }
  if (!await userSession(c.req.raw)) return c.html('<!doctype html><html lang="en"><meta charset="utf-8"><title>Agent Remote</title><h1>Agent Remote</h1><p>Sign in to the gateway, then return to this page.</p><a href="/">Open gateway</a></html>', 401)
  const host = c.req.query('host')
  if (host !== undefined && !validHostId(host)) return c.json({ error: 'Invalid Host' }, 400)
  const hostQuery = host ? `?host=${encodeURIComponent(host)}` : ''
  const challenge = c.req.query('challenge')
  if (challenge === undefined) return c.redirect(`${config.target}/auth/login${hostQuery}`, 303)
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return c.json({ error: 'Invalid login challenge' }, 400)
  const script = 'document.getElementById("launch-form").requestSubmit()'
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script))).toString('base64')
  c.header('content-security-policy', `default-src 'none'; script-src 'sha256-${hash}'; form-action 'self' ${config.target}; base-uri 'none'; frame-ancestors 'none'`)
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Agent Remote</title><h1>Agent Remote</h1><p>Open your private Agent Hosts and sessions. Access remains active while your gateway login is valid.</p><form id="launch-form" method="post" action="/api/agent-remote/launch"><input type="hidden" name="challenge" value="${challenge}">${host ? `<input type="hidden" name="host" value="${host}">` : ""}<button type="submit">Open remote controller</button></form><script>${script}</script></html>`)
})
agentRemoteRouter.post('/api/agent-remote/launch', async c => {
  const config = configuration()
  if (!config) return c.json({ error: 'Agent Remote is not configured' }, 503)
  const requestOrigin = c.req.header('origin')
  if (requestOrigin && requestOrigin !== config.issuer) return c.json({ error: 'Origin is not allowed' }, 403)
  const caller = await userSession(c.req.raw)
  if (!caller) return c.json({ error: 'An active user login session is required' }, 401)
  const form = c.req.header('content-type')?.split(';')[0] === 'application/x-www-form-urlencoded'
  if (!requestOrigin && (form || !c.req.header('authorization'))) return c.json({ error: 'Origin is required' }, 403)
  if (Number(c.req.header('content-length') ?? '0') > 1024) return c.json({ error: 'Request is too large' }, 413)
  const reader = c.req.raw.body?.getReader()
  let size = 0
  const chunks: Uint8Array[] = []
  if (reader) {
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.length
        if (size > 1024) { await reader.cancel(); return c.json({ error: 'Request is too large' }, 413) }
        chunks.push(result.value)
      }
    } finally { reader.releaseLock() }
  }
  const text = Buffer.concat(chunks).toString()
  let challenge: unknown
  let host: unknown
  try {
    if (form) {
      const values = new URLSearchParams(text)
      if (!values.has('challenge') || [...values.keys()].some(key => key !== 'challenge' && key !== 'host') || values.getAll('challenge').length !== 1 || values.getAll('host').length > 1) return c.json({ error: 'Only the login challenge and optional Host are accepted' }, 400)
      challenge = values.get('challenge')
      host = values.get('host') ?? undefined
    } else {
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || Object.keys(value).some(key => key !== 'challenge' && key !== 'host') || !('challenge' in value)) return c.json({ error: 'Only the login challenge and optional Host are accepted' }, 400)
      challenge = value.challenge
      host = 'host' in value ? value.host : undefined
    }
  } catch { return c.json({ error: 'Invalid login challenge' }, 400) }
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return c.json({ error: 'Invalid login challenge' }, 400)
  if (host !== undefined && !validHostId(host)) return c.json({ error: 'Invalid Host' }, 400)
  if (!remoteRateAllowed('launch', caller.user.id, 30)) {
    c.header('retry-after', '60')
    return c.json({ error: 'Too many launch requests' }, 429)
  }
  const now = Math.floor(Date.now() / 1000)
  const exp = Math.min(now + 900, Math.floor(Date.parse(caller.session.expiresAt) / 1000))
  if (exp <= now) return c.json({ error: 'Login session expired' }, 401)
  const header = encode({ alg: 'HS256', typ: 'arc-relay+jwt' })
  const authenticatedAt = Date.parse(caller.session.createdAt)
  if (!Number.isFinite(authenticatedAt) || authenticatedAt <= 0 || authenticatedAt > Date.now()) return c.json({ error: 'Invalid login authentication time' }, 401)
  const continuation = `arc2_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`
  const stored = await getRepo().agentRemoteContinuations.create({ handleHash: await continuationHash(continuation),
    issuer: config.issuer, audience: config.target, expiresAt: Date.parse(caller.session.expiresAt), authenticatedAt }, caller.session)
  if (!stored) return c.json({ error: 'Too many active remote logins' }, 429)
  remoteSecurityEvent('launch', 'allowed')
  const sessionExpiresAt = Date.parse(caller.session.expiresAt)
  const payload = encode({ continuation, sessionExpiresAt, authenticatedAt, iss: config.issuer, aud: config.target, sub: caller.user.id, nonce: challenge, iat: now, exp, jti: crypto.randomUUID() })
  const input = `${header}.${payload}`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))).toString('base64url')
  const launchUrl = `${config.target}/auth/callback${typeof host === "string" ? `?host=${encodeURIComponent(host)}` : ""}#ticket=${input}.${signature}`
  if (form) return c.redirect(launchUrl, 303)
  return c.json({ launchUrl, expiresAt: new Date(exp * 1000).toISOString() })
})
