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
import { getDumpLiveBroker, getDumpStore, getDumpStreamPermits } from '../../shared/dump/registry.ts'
import { dumpRecordToWire } from '../../shared/dump/wire.ts'
import { dumpRecordToExport } from '../../shared/dump/export.ts'
import type { DumpRecordId, StoredDumpRecord } from '../../shared/dump/types.ts'
import type { ApiKeyId } from '../../repo/branded-ids.ts'

import { DUMP_LIVE_QUEUE_POLICY, selectLatestDumpSnapshot } from '../../shared/dump/live-policy.ts'
import { ChannelCapacityError, type ChannelCapacityReason } from '../../shared/runtime/channel-broker-contract.ts'

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
    const retire = getDumpStreamPermits().acquire(owned)
    if (!retire) {
      c.header('Retry-After', '5')
      return c.json({ error: 'Diagnostic live stream capacity is unavailable.' }, 429)
    }
    const latest = c.req.query('view') === 'latest-v1'
    const controller = new AbortController()
    let cleaned = false
    let writerOwnsPermit = false
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
      // Subscribe before SQL; cancellation detaches immediately, but started SQL
      // still owns its permit until actual settlement (there is no cancel port).
      const subscription = getDumpLiveBroker().subscribeBounded(owned, controller.signal, DUMP_LIVE_QUEUE_POLICY)
      if (controller.signal.aborted) return c.body(null)
      const snapshot = await getDumpStore().list(owned, { limit: LIST_LIMIT_DEFAULT })
      if (controller.signal.aborted) return c.body(null)
      let snapshotData: string | undefined
      let snapshotFailure: ChannelCapacityReason | undefined
      if (subscription.state.status !== 'reconciliation_required') {
        try {
          snapshotData = JSON.stringify(latest ? selectLatestDumpSnapshot(snapshot) : { records: snapshot })
        } catch (error) {
          if (!(error instanceof ChannelCapacityError)) throw error
          snapshotFailure = error.reason
          subscription.cancel()
        }
      }

      const response = streamSSE(c, async (stream) => {
        stream.onAbort(cleanup)
        const overflowed = () => snapshotFailure !== undefined || subscription.state.status === 'reconciliation_required'
        const writable = () => !controller.signal.aborted && !stream.aborted
        const reconcile = async () => {
          const state = subscription.state
          const reason = state.status === 'reconciliation_required' ? state.reason : snapshotFailure
          if (latest && writable() && reason !== undefined) {
            await stream.writeSSE({ event: 'reconciliation_required', data: JSON.stringify({
              reason, recovery: 'latest_snapshot', completeHistory: false,
            }) })
          }
        }
        try {
          if (!writable()) return
          if (overflowed()) { await reconcile(); return }
          if (snapshotData === undefined) return
          await stream.writeSSE({ event: 'snapshot', data: snapshotData })
          if (!writable()) return
          if (overflowed()) { await reconcile(); return }
          try {
            for await (const meta of subscription.iterable) {
              // A resolved read is not authority after overflow/abort reentry.
              if (!writable()) return
              if (overflowed()) { await reconcile(); return }
              const data = JSON.stringify(meta)
              if (!writable()) return
              if (overflowed()) { await reconcile(); return }
              await stream.writeSSE({ event: 'appended', data })
              if (!writable()) return
              if (overflowed()) { await reconcile(); return }
            }
          } catch (err) {
            if (!writable()) return
            if (err instanceof ChannelCapacityError) { await reconcile(); return }
            await stream.writeSSE({ event: 'error', data: JSON.stringify({
              message: err instanceof Error ? err.message : String(err),
            }) })
          }
        } finally {
          cleanup()
          // Hono returns Response before this callback settles. Its close is
          // also asynchronous; retire only after all started writer work ends.
          try { await stream.close() } finally { retire() }
        }
      })
      writerOwnsPermit = true
      return response
    } catch (err) {
      cleanup()
      if (signal.aborted) return c.body(null)
      throw err
    } finally {
      if (!writerOwnsPermit) { cleanup(); retire() }
    }
  })
