/**
 * data-transfer control-plane router — Week 5b port of
 * src/routes/dashboard.ts (GET /export, POST /import).
 *
 * Admin only. Wraps control-plane/lib/import-export.ts:
 *  - GET /export?redact=1 — serialize apiKeys + githubAccounts + upstreams,
 *    optionally redact secrets to REDACTED sentinel.
 *  - POST /import — body { mode: 'merge'|'replace', bundle }. parseConfigBundle
 *    validates, unredactWithLive restores REDACTED from live state, replace
 *    mode deletes-all first, then upserts.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../../app.ts'
import { zValidator } from '../middleware/zod-validator.ts'
import { getRepo } from '../../repo/index.ts'
import {
  exportConfig,
  parseConfigBundle,
  unredactWithLive,
} from '../lib/import-export.ts'
import { notifyConfigurationImported } from '../../sync/hooks.ts'
import { withSyncLock } from '../../sync/lock.ts'

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

const importBody = z.object({
  mode: z.enum(['merge', 'replace'], { message: "mode must be 'merge' or 'replace'" }),
  bundle: z.unknown(),
})

dataTransferRouter.post('/import', zValidator('json', importBody), async (c) => {
  const auth = c.get('auth') ?? {}
  if (!auth.isAdmin) {
    return c.json({ error: 'Admin only' }, 403)
  }
  const { mode, bundle } = c.req.valid('json')

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

  // Synced upstreams belong to the sync source. A bundle never overrides them (not even by id), and replace keeps them.
  const syncedIds = new Set(liveUpstreams.filter((u) => u.syncSourceId).map((u) => u.id))
  const importable = merged.upstreams.filter((u) => !syncedIds.has(u.id))

  // May wait for an in-flight sync tick (bounded by the 15 s fetch timeout).
  // Under the sync lock so a scheduled tick cannot interleave with the writes or reuse the stored ETag afterwards.
  await withSyncLock(async () => {
    if (mode === 'replace') {
      await Promise.all([
        repo.apiKeys.deleteAll(),
        repo.github.deleteAllAccounts(),
        repo.upstreams.deleteAll(), // keeps rows that have sync_source_id
      ])
    }

    for (const key of merged.apiKeys) await repo.apiKeys.save(key)
    for (const account of merged.githubAccounts) {
      await repo.github.saveAccount(account.user.id, account)
    }
    for (const upstream of importable) {
      await repo.upstreams.save(upstream)
    }

    // Forget the stored ETag so the sync after an import gets a full 200 snapshot and re-applies synced rows
    // (status and last_error stay as they were).
    const source = await repo.syncSources.get()
    if (source) {
      await repo.syncSources.recordResult(source.id, source.secret, {
        attemptAt: source.lastAttemptAt ?? new Date().toISOString(),
        etag: null,
        error: source.lastError,
      })
    }
  })

  // Device gateways re-sync right away after an import (see the ETag reset above).
  notifyConfigurationImported()

  return c.json({
    ok: true,
    sourceVersion: parsed.sourceVersion,
    imported: {
      apiKeys: merged.apiKeys.length,
      githubAccounts: merged.githubAccounts.length,
      upstreams: importable.length,
    },
    redactedCount: parsed.redactedCount,
  })
})
