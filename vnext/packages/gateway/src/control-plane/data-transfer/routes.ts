/**
 * data-transfer control-plane router — Week 5b port of
 * src/routes/dashboard.ts (GET /export, POST /import).
 *
 * Admin only. Wraps shared/lib/import-export.ts:
 *  - GET /export?redact=1 — serialize apiKeys + githubAccounts + upstreams,
 *    optionally redact secrets to REDACTED sentinel.
 *  - POST /import — body { mode: 'merge'|'replace', bundle }. parseConfigBundle
 *    validates, unredactWithLive restores REDACTED from live state, replace
 *    mode deletes-all first, then upserts.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../shared/repo/index.ts'
import {
  exportConfig,
  parseConfigBundle,
  unredactWithLive,
} from '../../shared/lib/import-export.ts'

export interface DataTransferAuthCtx {
  isAdmin?: boolean
}

type Vars = { auth: DataTransferAuthCtx }

export const dataTransferRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

dataTransferRouter.get('/export', async (c) => {
  const auth = c.get('auth') ?? {}
  if (!auth.isAdmin) {
    return c.json({ error: 'Admin only' }, 403)
  }
  const repo = getRepo()
  const redactSecrets = c.req.query('redact') === '1'
  const [apiKeys, githubAccounts, upstreams] = await Promise.all([
    repo.apiKeys.list(),
    repo.github.listAccounts(),
    repo.upstreams.list({ includeDisabled: true }),
  ])
  return c.json(exportConfig({ apiKeys, githubAccounts, upstreams }, { redactSecrets }))
})

dataTransferRouter.post('/import', async (c) => {
  const auth = c.get('auth') ?? {}
  if (!auth.isAdmin) {
    return c.json({ error: 'Admin only' }, 403)
  }
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string; bundle?: unknown }
  const { mode, bundle } = body

  if (mode !== 'merge' && mode !== 'replace') {
    return c.json({ error: "mode must be 'merge' or 'replace'" }, 400)
  }

  let parsed
  try {
    parsed = parseConfigBundle(bundle)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }

  const repo = getRepo()
  const [liveKeys, liveAccounts, liveUpstreams] = await Promise.all([
    repo.apiKeys.list(),
    repo.github.listAccounts(),
    repo.upstreams.list({ includeDisabled: true }),
  ])
  const merged = unredactWithLive(parsed.bundle, {
    apiKeys: liveKeys,
    githubAccounts: liveAccounts,
    upstreams: liveUpstreams,
  })

  if (mode === 'replace') {
    await Promise.all([
      repo.apiKeys.deleteAll(),
      repo.github.deleteAllAccounts(),
      repo.upstreams.deleteAll(),
    ])
  }

  for (const key of merged.apiKeys) await repo.apiKeys.save(key)
  for (const account of merged.githubAccounts) {
    await repo.github.saveAccount(account.user.id, account)
  }
  for (const upstream of merged.upstreams) {
    await repo.upstreams.save(upstream)
  }

  return c.json({
    ok: true,
    sourceVersion: parsed.sourceVersion,
    imported: {
      apiKeys: merged.apiKeys.length,
      githubAccounts: merged.githubAccounts.length,
      upstreams: merged.upstreams.length,
    },
    redactedCount: parsed.redactedCount,
  })
})
