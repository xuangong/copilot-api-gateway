// Control-plane per-API-key request dump endpoints. Three routes:
//   - GET  /api/keys/:keyId/records         → paginated list (newest first)
//   - GET  /api/keys/:keyId/records/:recordId → detail (wire shape)
//   - GET  /api/keys/:keyId/stream          → SSE live feed (snapshot + appended)
//
// Ported 1:1 from copilot-gateway/control-plane/dump.ts, with vNext auth
// conventions (c.get('auth') + repo.apiKeys.getById) and no zValidator
// dependency (query params parsed inline against the existing patterns in
// vNext control-plane).
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../repo/index.ts'
import { getDumpBroker, getDumpStore } from '../../shared/dump/registry.ts'
import { dumpRecordToWire } from '../../shared/dump/wire.ts'
import { dumpRecordToExport } from '../../shared/dump/export.ts'
import type { DumpRecordId, StoredDumpRecord } from '../../shared/dump/types.ts'
import type { ApiKeyId } from '../../repo/branded-ids.ts'

const LIST_LIMIT_DEFAULT = 100
const LIST_LIMIT_MAX = 200

// Owner-scoped key lookup + dump-enabled gate. Returns:
//   - the key id (string) when the caller owns a key with dump retention on
//   - a Response (404 / 403) otherwise
//
// Admin passthrough matches other control-plane routes (see api-keys/routes.ts).
const ownedDumpKey = async (c: Context): Promise<ApiKeyId | Response> => {
  const auth = c.get('auth') ?? {}
  const keyId = c.req.param('keyId')! as ApiKeyId
  const key = await getRepo().apiKeys.getById(keyId)
  if (!key) return c.json({ error: 'Key not found' }, 404)
  const hasIdentity = typeof auth.userId === 'string' && auth.userId.trim().length > 0
  const ownsKey = hasIdentity && typeof key.ownerId === 'string'
    && key.ownerId.trim().length > 0 && key.ownerId === auth.userId
  if (!hasIdentity || (auth.isAdmin !== true && !ownsKey)) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  if (key.dumpRetentionSeconds === null || key.dumpRetentionSeconds === undefined) {
    return c.json({ error: 'Dump capture is not enabled for this key.' }, 404)
  }
  return key.id
}

const parsePositiveInt = (v: string | undefined, fallback: number, max: number): number => {
  if (v === undefined) return fallback
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, max)
}

const readRecord = async (c: Context, keyId: ApiKeyId, recordId: DumpRecordId): Promise<StoredDumpRecord | null | Response> => {
  try {
    return await getDumpStore().get(keyId, recordId)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('dump body missing for key=')) {
      return c.json({ error: 'Captured body is no longer available.' }, 409)
    }
    return c.json({ error: 'Captured record could not be read.' }, 500)
  }
}

export const dumpRoutes = new Hono<{ Bindings: Env }>()
  .get('/:keyId/records', async (c) => {
    const owned = await ownedDumpKey(c)
    if (owned instanceof Response) return owned
    const limit = parsePositiveInt(c.req.query('limit'), LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX)
    const before = c.req.query('before')
    const records = await getDumpStore().list(owned, {
      limit,
      ...(before !== undefined ? { before: before as DumpRecordId } : {}),
    })
    return c.json({ records })
  })
  .get('/:keyId/records/:recordId', async (c) => {
    const owned = await ownedDumpKey(c)
    if (owned instanceof Response) return owned
    const recordId = c.req.param('recordId')! as DumpRecordId
    const record = await readRecord(c, owned, recordId)
    if (record instanceof Response) return record
    if (!record) return c.json({ error: 'Record not found' }, 404)
    return c.json(dumpRecordToWire(record))
  })
  .get('/:keyId/records/:recordId/export', async (c) => {
    const owned = await ownedDumpKey(c)
    if (owned instanceof Response) return owned
    const id = c.req.param('recordId')
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.json({ error: 'Invalid record ID' }, 400)
    const record = await readRecord(c, owned, id as DumpRecordId)
    if (record instanceof Response) return record
    if (!record) return c.json({ error: 'Record not found' }, 404)
    return new Response(JSON.stringify(dumpRecordToExport(record)), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="request-${id}.json"`,
      },
    })
  })
  .get('/:keyId/stream', async (c) => {
    // Browsers cannot set custom headers on EventSource, so this route is
    // reached over cookie-based session auth (see session-auth middleware).
    const owned = await ownedDumpKey(c)
    if (owned instanceof Response) return owned

    const signal = c.req.raw.signal
    if (signal.aborted) return c.body(null)
    const controller = new AbortController()
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      signal.removeEventListener('abort', onAbort)
      controller.abort()
    }
    const onAbort = () => cleanup()
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      if (signal.aborted) {
        cleanup()
        return c.body(null)
      }
      // Subscribe first, then read the snapshot, so anything new during the
      // snapshot query is still delivered via the live subscription.
      const subscription = getDumpBroker().subscribe(owned, controller.signal)
      if (controller.signal.aborted) return c.body(null)
      // The store has no cancellation port. Observe its settlement, but never
      // begin SSE delivery if the request closed while this read was pending.
      const snapshot = await getDumpStore().list(owned, { limit: LIST_LIMIT_DEFAULT })
      if (controller.signal.aborted) return c.body(null)

      return streamSSE(c, async (stream) => {
        stream.onAbort(cleanup)
        try {
          if (controller.signal.aborted) return
          await stream.writeSSE({ event: 'snapshot', data: JSON.stringify({ records: snapshot }) })
          try {
            for await (const meta of subscription) {
              await stream.writeSSE({ event: 'appended', data: JSON.stringify(meta) })
            }
          } catch (err) {
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
            })
          }
        } finally {
          cleanup()
        }
      })
    } catch (err) {
      cleanup()
      if (signal.aborted) return c.body(null)
      throw err
    }
  })
