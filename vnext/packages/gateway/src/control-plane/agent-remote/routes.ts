import { Hono } from 'hono'
import { env } from '@vibe-core/platform'
import { getRepo } from '../../repo/index.ts'
import type { SessionToken } from '../../repo/branded-ids.ts'

function origin(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Agent Remote requires an HTTPS origin or loopback HTTP origin')
  }
  return url.origin
}
function configuration() {
  const target = env('AGENT_REMOTE_RELAY_URL')
  const secret = env('AGENT_REMOTE_SIGNING_SECRET')
  const issuer = env('AGENT_REMOTE_ISSUER')
  if (!target || !secret || !issuer) return undefined
  if (new TextEncoder().encode(secret).length < 32) throw new Error('Agent Remote signing secret must contain at least 32 bytes')
  return { target: origin(target), issuer: origin(issuer), secret }
}
async function userSession(request: Request) {
  const authorization = request.headers.get('authorization')
  const token = authorization ? /^Bearer (ses_[^\s]+)$/i.exec(authorization)?.[1]
    : /(?:^|;\s*)session_token=(ses_[^\s;]+)/.exec(request.headers.get('cookie') ?? '')?.[1]
  if (!token || token.length > 4096) return undefined
  const repo = getRepo()
  const session = await repo.sessions.findByToken(token as SessionToken)
  if (!session || !(Date.parse(session.expiresAt) > Date.now())) return undefined
  const user = await repo.users.getById(session.userId)
  return user && !user.disabled ? { user, session } : undefined
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

export const agentRemoteRouter = new Hono()
agentRemoteRouter.use('/agent-remote', secureResponse)
agentRemoteRouter.use('/api/agent-remote/launch', secureResponse)
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
  if (!await userSession(c.req.raw)) return c.html('<!doctype html><html lang="en"><meta charset="utf-8"><title>Agent Remote</title><h1>Agent Remote</h1><p>Sign in to the gateway, then return to this page.</p><a href="/">Open gateway</a></html>', 401)
  const challenge = c.req.query('challenge')
  if (challenge === undefined) return c.redirect(`${config.target}/auth/login`, 303)
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return c.json({ error: 'Invalid login challenge' }, 400)
  c.header('content-security-policy', `default-src 'none'; form-action 'self' ${config.target}; base-uri 'none'; frame-ancestors 'none'`)
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Agent Remote</title><h1>Agent Remote</h1><p>Open your private Agent Hosts and sessions. Access lasts up to 15 minutes.</p><form method="post" action="/api/agent-remote/launch"><input type="hidden" name="challenge" value="${challenge}"><button type="submit">Open remote controller</button></form></html>`)
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
  try {
    if (form) {
      const values = new URLSearchParams(text)
      if ([...values.keys()].length !== 1 || !values.has('challenge')) return c.json({ error: 'Only the login challenge is accepted' }, 400)
      challenge = values.get('challenge')
    } else {
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !('challenge' in value)) return c.json({ error: 'Only the login challenge is accepted' }, 400)
      challenge = value.challenge
    }
  } catch { return c.json({ error: 'Invalid login challenge' }, 400) }
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return c.json({ error: 'Invalid login challenge' }, 400)
  const now = Math.floor(Date.now() / 1000)
  const exp = Math.min(now + 900, Math.floor(Date.parse(caller.session.expiresAt) / 1000))
  if (exp <= now) return c.json({ error: 'Login session expired' }, 401)
  const header = encode({ alg: 'HS256', typ: 'arc-relay+jwt' })
  const payload = encode({ iss: config.issuer, aud: config.target, sub: caller.user.id, nonce: challenge, iat: now, exp, jti: crypto.randomUUID() })
  const input = `${header}.${payload}`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))).toString('base64url')
  const launchUrl = `${config.target}/auth/callback#ticket=${input}.${signature}`
  if (form) return c.redirect(launchUrl, 303)
  return c.json({ launchUrl, expiresAt: new Date(exp * 1000).toISOString() })
})
