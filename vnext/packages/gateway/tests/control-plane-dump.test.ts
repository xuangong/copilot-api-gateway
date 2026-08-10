// Control-plane dump routes — list/detail/SSE with in-memory DumpStore + DumpBroker fakes.
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/repo/index.ts'
import { initDumpStore, initDumpBroker, resetDumpRegistryForTests } from '../src/shared/dump/registry.ts'
import type { ApiKey, Repo } from '../src/repo/types.ts'
import type {
  DumpStore,
  DumpListOptions,
} from '../src/shared/dump/store-contract.ts'
import type {
  DumpMetadata,
  DumpRecordId,
  DumpWriteRecord,
  PreparedDumpRequestBody,
  StoredDumpRecord,
} from '../src/shared/dump/types.ts'
import type { DumpBroker } from '../src/shared/dump/broker.ts'
import { dumpRoutes } from '../src/control-plane/dump/routes.ts'

// --- minimal in-memory Repo covering apiKeys.getById ---
function inMemoryRepo() {
  const keys = new Map<string, ApiKey>()
  const repo = {
    apiKeys: {
      list: async () => [...keys.values()],
      listByOwner: async (owner: string) => [...keys.values()].filter((k) => k.ownerId === owner),
      findByRawKey: async () => null,
      getById: async (id: string) => keys.get(id) ?? null,
      save: async (k: ApiKey) => { keys.set(k.id, k) },
      delete: async (id: string) => keys.delete(id),
      deleteAll: async () => { keys.clear() },
    },
  } as unknown as Repo
  return { repo, keys }
}

// --- minimal in-memory DumpStore ---
class MemoryDumpStore implements DumpStore {
  byKey = new Map<string, StoredDumpRecord[]>()
  async prepareRequestBody(bytes: Uint8Array): Promise<PreparedDumpRequestBody> {
    return { encoding: 'identity', bytes, decodedByteLength: bytes.byteLength }
  }
  async put(_keyId: string, _record: DumpWriteRecord): Promise<void> { /* not needed for control-plane tests */ }
  async list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]> {
    const all = [...(this.byKey.get(keyId) ?? [])]
    all.sort((a, b) => b.meta.completedAt - a.meta.completedAt || (b.meta.id > a.meta.id ? 1 : -1))
    let filtered = all
    if (opts.before !== undefined) {
      const idx = filtered.findIndex((r) => r.meta.id === opts.before)
      if (idx >= 0) filtered = filtered.slice(idx + 1)
    }
    return filtered.slice(0, opts.limit).map((r) => r.meta)
  }
  async get(keyId: string, recordId: DumpRecordId): Promise<StoredDumpRecord | null> {
    return (this.byKey.get(keyId) ?? []).find((r) => r.meta.id === recordId) ?? null
  }
  async deleteExpiredBatch(): Promise<number> { return 0 }
  async findOldestCreatedAt(): Promise<number | null> { return null }
}

// --- minimal in-memory DumpBroker ---
class MemoryDumpBroker implements DumpBroker {
  async publish(): Promise<void> { /* no live delivery in these tests */ }
  subscribe(_channelId: string, _signal: AbortSignal) {
    return (async function* () { /* empty */ })()
  }
  async closeChannel(): Promise<void> { }
}

function makeRecord(id: string, keyId: string, completedAt: number): StoredDumpRecord {
  return {
    meta: {
      id: id as DumpRecordId,
      startedAt: completedAt - 100,
      completedAt,
      method: 'POST',
      path: '/v1/chat/completions',
      status: 200,
      upstream: null,
      model: 'gpt-4',
      inputTokens: 10,
      outputTokens: 20,
      requestBytes: 5,
      responseBytes: 5,
      durationMs: 100,
      error: null,
    },
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: [['content-type', 'application/json']],
      body: new TextEncoder().encode('{"model":"gpt-4"}'),
    },
    response: {
      status: 200,
      headers: [['content-type', 'application/json']],
      body: { type: 'bytes', body: new TextEncoder().encode('{"ok":true}') },
    },
  }
}

function buildApp(auth: { userId?: string; isAdmin?: boolean }) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth' as never, auth as never)
    return next()
  })
  app.route('/api/keys', dumpRoutes)
  return app
}

let repoCtx: ReturnType<typeof inMemoryRepo>
let store: MemoryDumpStore
let broker: MemoryDumpBroker

beforeEach(() => {
  repoCtx = inMemoryRepo()
  initRepo(repoCtx.repo)
  store = new MemoryDumpStore()
  broker = new MemoryDumpBroker()
  resetDumpRegistryForTests()
  initDumpStore(store)
  initDumpBroker(broker)
})

const saveKey = async (id: string, ownerId: string, retention: number | null) => {
  await repoCtx.repo.apiKeys.save({
    id, name: `k-${id}`, key: `raw-${id}`, createdAt: new Date().toISOString(),
    ownerId, dumpRetentionSeconds: retention,
  } as unknown as ApiKey)
}

test('GET /:keyId/records returns newest-first list for owner', async () => {
  await saveKey('k1', 'u1', 3600)
  store.byKey.set('k1', [
    makeRecord('01H000000000000000000000A1', 'k1', 100),
    makeRecord('01H000000000000000000000A2', 'k1', 200),
    makeRecord('01H000000000000000000000A3', 'k1', 150),
  ])
  const res = await buildApp({ userId: 'u1' }).request('/api/keys/k1/records')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { records: DumpMetadata[] }
  expect(body.records.map((r) => r.id)).toEqual([
    '01H000000000000000000000A2',
    '01H000000000000000000000A3',
    '01H000000000000000000000A1',
  ])
})

test('GET /:keyId/records respects limit + before cursor', async () => {
  await saveKey('k1', 'u1', 3600)
  store.byKey.set('k1', [
    makeRecord('01A', 'k1', 100),
    makeRecord('01B', 'k1', 200),
    makeRecord('01C', 'k1', 300),
  ])
  const res = await buildApp({ userId: 'u1' }).request('/api/keys/k1/records?limit=1&before=01C')
  const body = (await res.json()) as { records: DumpMetadata[] }
  expect(body.records.map((r) => r.id)).toEqual(['01B'])
})

test('GET /:keyId/records/:recordId returns wire shape', async () => {
  await saveKey('k1', 'u1', 3600)
  const rec = makeRecord('01H0000000000000000000REC1', 'k1', 100)
  store.byKey.set('k1', [rec])
  const res = await buildApp({ userId: 'u1' }).request('/api/keys/k1/records/01H0000000000000000000REC1')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { request: { body: { encoding: string; data: string } } }
  expect(body.request.body.encoding).toBe('utf8')
  expect(body.request.body.data).toBe('{"model":"gpt-4"}')
})

test('GET /:keyId/records/:recordId 404 when missing', async () => {
  await saveKey('k1', 'u1', 3600)
  const res = await buildApp({ userId: 'u1' }).request('/api/keys/k1/records/nope')
  expect(res.status).toBe(404)
})

test('dumpRetentionSeconds null → 404 on records and detail', async () => {
  await saveKey('k1', 'u1', null)
  store.byKey.set('k1', [makeRecord('01A', 'k1', 100)])
  const app = buildApp({ userId: 'u1' })
  expect((await app.request('/api/keys/k1/records')).status).toBe(404)
  expect((await app.request('/api/keys/k1/records/01A')).status).toBe(404)
})

test('non-owner gets 403', async () => {
  await saveKey('k1', 'u1', 3600)
  store.byKey.set('k1', [makeRecord('01A', 'k1', 100)])
  const res = await buildApp({ userId: 'other' }).request('/api/keys/k1/records')
  expect(res.status).toBe(403)
})

test('admin bypass sees records for any owner', async () => {
  await saveKey('k1', 'u1', 3600)
  store.byKey.set('k1', [makeRecord('01A', 'k1', 100)])
  const res = await buildApp({ isAdmin: true }).request('/api/keys/k1/records')
  expect(res.status).toBe(200)
})

test('missing key returns 404', async () => {
  const res = await buildApp({ userId: 'u1' }).request('/api/keys/ghost/records')
  expect(res.status).toBe(404)
})
