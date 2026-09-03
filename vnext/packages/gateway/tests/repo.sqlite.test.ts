import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'

const newRepo = (db = new Database(":memory:")) => ({ repo: new SqliteRepo(db), db })

test('SqliteRepo: apiKeys save + lookup round-trip', async () => {
  const { repo } = newRepo()
  const now = new Date().toISOString()
  await repo.apiKeys.save({
    id: 'k1', name: 'test', key: 'raw-secret-1', createdAt: now, ownerId: 'u1',
    modelMappingsEnabled: false,
    modelMappings: [],
  })
  const byId = await repo.apiKeys.getById('k1')
  expect(byId?.name).toBe('test')
  const byKey = await repo.apiKeys.findByRawKey('raw-secret-1')
  expect(byKey?.id).toBe('k1')
  const list = await repo.apiKeys.listByOwner('u1')
  expect(list.length).toBe(1)
  expect(await repo.apiKeys.delete('k1')).toBe(true)
  expect(await repo.apiKeys.getById('k1')).toBeNull()
})

test("SqliteRepo: api key mappings preserve ordered duplicates and explicit empty lists", async () => {
  const { repo } = newRepo()
  const now = new Date().toISOString()
  const mappings = [
    { source: "a", destination: "b" },
    { source: "a", destination: "c" },
    { source: "c", destination: "d" },
  ]
  await repo.apiKeys.save({
    id: "k-mappings",
    name: "mappings",
    key: "raw-secret-mappings",
    createdAt: now,
    modelMappingsEnabled: true,
    modelMappings: mappings,
  })

  expect(await repo.apiKeys.getById("k-mappings")).toMatchObject({
    modelMappingsEnabled: true,
    modelMappings: mappings,
    modelMappingsInvalid: false,
  })

  await repo.apiKeys.save({
    id: "k-empty",
    name: "empty",
    key: "raw-secret-empty",
    createdAt: now,
    modelMappingsEnabled: false,
    modelMappings: [],
  })
  expect(await repo.apiKeys.getById("k-empty")).toMatchObject({
    modelMappingsEnabled: false,
    modelMappings: [],
    modelMappingsInvalid: false,
  })
})

test("SqliteRepo: partial mapping patches leave unrelated columns intact", async () => {
  const { repo } = newRepo()
  const now = new Date().toISOString()
  await repo.apiKeys.save({
    id: 'k-patch', name: 'original', key: 'raw-secret-patch', createdAt: now,
    quotaRequestsPerMonth: 10, modelMappingsEnabled: false, modelMappings: [{ source: 'a', destination: 'b' }],
  })
  await repo.apiKeys.patchModelMappings('k-patch', { modelMappingsEnabled: true })
  let saved = await repo.apiKeys.getById('k-patch')
  expect(saved).toMatchObject({ name: 'original', quotaRequestsPerMonth: 10, modelMappingsEnabled: true, modelMappings: [{ source: 'a', destination: 'b' }] })
  await repo.apiKeys.patchModelMappings('k-patch', { modelMappings: [] })
  saved = await repo.apiKeys.getById('k-patch')
  expect(saved).toMatchObject({ modelMappingsEnabled: true, modelMappings: [] })
})

test("SqliteRepo: toggling mappings and full saves retain the list", async () => {
  const { repo } = newRepo()
  const now = new Date().toISOString()
  const key = {
    id: "k-toggle",
    name: "original",
    key: "raw-secret-toggle",
    createdAt: now,
    modelMappingsEnabled: true,
    modelMappings: [{ source: "a", destination: "b" }],
  }
  await repo.apiKeys.save(key)
  await repo.apiKeys.save({ ...key, modelMappingsEnabled: false })
  await repo.apiKeys.save({ ...key, name: "renamed", modelMappingsEnabled: false })

  expect(await repo.apiKeys.getById("k-toggle")).toMatchObject({
    name: "renamed",
    modelMappingsEnabled: false,
    modelMappings: [{ source: "a", destination: "b" }],
  })
})

test("SqliteRepo: corrupt model mappings fail closed as a whole", async () => {
  const { repo, db } = newRepo()
  const now = new Date().toISOString()
  const invalidValues = [
    "not-json",
    "{}",
    "[null]",
    '[{"source":"a","destination":"b"},null]',
    '[{"source":1,"destination":"b"}]',
    '[{"source":"a","destination":1}]',
    '[{"source":"   ","destination":"b"}]',
    '[{"source":"a","destination":"   "}]',
    JSON.stringify(Array.from({ length: 101 }, () => ({ source: "a", destination: "b" }))),
    JSON.stringify([{ source: "a".repeat(257), destination: "b" }]),
    JSON.stringify([{ source: "a", destination: "b".repeat(257) }]),
  ]

  for (const [index, modelMappings] of invalidValues.entries()) {
    await repo.apiKeys.save({
      id: `k-invalid-${index}`,
      name: "invalid",
      key: `raw-secret-invalid-${index}`,
      createdAt: now,
      modelMappingsEnabled: true,
      modelMappings: [],
    })
    db.query("UPDATE api_keys SET model_mappings = ? WHERE id = ?").run(modelMappings, `k-invalid-${index}`)
    expect(await repo.apiKeys.getById(`k-invalid-${index}`)).toMatchObject({
      modelMappingsEnabled: false,
      modelMappings: [],
      modelMappingsInvalid: true,
    })
  }
})

test('SqliteRepo: upstreams save + list round-trip', async () => {
  const { repo } = newRepo()
  const now = new Date().toISOString()
  await repo.upstreams.save({
    id: 'ups-1',
    provider: 'copilot',
    name: 'ups-1',
    ownerId: 'u1',
    enabled: true,
    sortOrder: 0,
    config: {},
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: now,
    updatedAt: now,
  })
  const found = await repo.upstreams.getById('ups-1')
  expect(found?.name).toBe('ups-1')
  const all = await repo.upstreams.list({ ownerId: 'u1' })
  expect(all.length).toBe(1)
})
