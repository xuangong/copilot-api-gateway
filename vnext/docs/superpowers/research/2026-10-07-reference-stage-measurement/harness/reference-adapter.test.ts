import { afterEach, expect, test } from "bun:test"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gzipSync } from "node:zlib"
import { buildReference, readReferenceStorage, seedReference } from "./reference-adapter.ts"
import type { ReferenceDatabase } from "./reference-adapter.ts"

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected test record")
  return value as Record<string, unknown>
}
function sqliteBoundary(sqlite: Database): ReferenceDatabase {
  return { prepare(sql: string) {
    const statement = sqlite.prepare(sql)
    const bound = (values: SQLQueryBindings[]) => ({ async run() { return statement.run(...values) }, async all<T>() { return { results: statement.all(...values) as T[] } } })
    return { ...bound([]), bind(...values: SQLQueryBindings[]) { return bound(values) } }
  } }
}
function sqlFixture() {
  const sqlite = new Database(":memory:")
  sqlite.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE api_keys(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE, server_secret TEXT NOT NULL CHECK(length(server_secret) = 64 AND server_secret NOT GLOB '*[^0-9a-f]*'), created_at TEXT NOT NULL, dump_retention_seconds INTEGER, responses_retention_seconds INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE upstreams(id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, config_json TEXT NOT NULL, proxy_fallback_list_json TEXT NOT NULL, hue INTEGER NOT NULL CHECK(hue >= 0 AND hue < 360), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE dump_records(key_id TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL, upstream_id TEXT, meta_json TEXT NOT NULL, request_headers_json TEXT NOT NULL, response_headers_json TEXT, request_body_descriptor TEXT, response_body_descriptor TEXT, response_upstream_body_descriptor TEXT);
    CREATE TABLE spilled_files(file_key TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_key TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE usage(metric TEXT, amount TEXT); CREATE TABLE usage_requests(requests INTEGER);
    CREATE TABLE performance_summary(requests INTEGER); CREATE TABLE performance_buckets(count INTEGER);
    CREATE TABLE responses_snapshots(id TEXT); CREATE TABLE responses_items(id TEXT);
  `)
  return { db: sqliteBoundary(sqlite), sqlite }
}
const seed = { baseUrl: "http://127.0.0.1:49999", apiKey: "isolated-key", fixtureSecret: "fixture-secret", dump: true, model: "bench-chat-success" }

test("seed uses R integer user identity, server secret and structured Chat capabilities", async () => {
  const { db, sqlite } = sqlFixture()
  try {
    await seedReference(db, seed)
    const key = record(sqlite.query("SELECT * FROM api_keys").get())
    const user = record(sqlite.query("SELECT * FROM users").get())
    const upstream = record(sqlite.query("SELECT * FROM upstreams").get())
    expect(key.user_id).toBe(user.id)
    expect(typeof user.id).toBe("number")
    expect(key.server_secret).toMatch(/^[0-9a-f]{64}$/)
    expect(key.responses_retention_seconds).toBe(0)
    expect(key.dump_retention_seconds).toBe(0)
    const config = record(JSON.parse(String(upstream.config_json)))
    expect(config.baseUrl).toBe(seed.baseUrl + "/v1")
    expect(config.modelsFetch).toEqual({ enabled: false })
    expect(config.endpoints).toEqual({ openaiChatCompletions: {} })
    expect(config.models).toEqual([{ kind: "chat", upstreamModelId: seed.model, publicModelId: seed.model, endpoints: { openaiChatCompletions: {} } }])
    expect(config.ingressHeadersRules).toEqual([])
    expect(JSON.parse(String(upstream.proxy_fallback_list_json))).toEqual([{ id: "direct_fetch" }])
  } finally { sqlite.close() }
})

test("seed dump-disabled control uses NULL and rejects nonlocal or credentialed fixture URLs before writes", async () => {
  const { db, sqlite } = sqlFixture()
  try {
    for (const baseUrl of ["https://example.com", "http://u:p@127.0.0.1:99", "http://127.0.0.1:99/path?x=1"]) {
      await expect(seedReference(db, { ...seed, baseUrl })).rejects.toThrow("fixture")
    }
    expect(sqlite.query("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 })
    await seedReference(db, { ...seed, dump: false })
    expect(sqlite.query("SELECT dump_retention_seconds FROM api_keys").get()).toEqual({ dump_retention_seconds: null })
  } finally { sqlite.close() }
})

test("real R migrations preserve the bootstrap admin while fixture seed and physical readback satisfy ownership triggers", async () => {
  const root = process.env.REFERENCE_SOURCE_ROOT ?? "/Volumes/Projects/copilot-gateway"
  const migrations = join(root, "packages/gateway/migrations")
  const names = readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()
  expect(names.length).toBeGreaterThanOrEqual(85)
  const sqlite = new Database(":memory:")
  const db = sqliteBoundary(sqlite)
  try {
    for (const name of names) {
      try { sqlite.exec(readFileSync(join(migrations, name), "utf8")) }
      catch (cause) { throw new Error(`Real reference migration failed: ${name}`, { cause }) }
    }
    const bootstrapAdmin = record(sqlite.query("SELECT id,username,is_admin FROM users WHERE id = 1").get())
    expect(bootstrapAdmin).toEqual({ id: 1, username: "admin", is_admin: 1 })
    await seedReference(db, seed)
    expect(sqlite.query("SELECT id,username,is_admin FROM users WHERE id = 1").get()).toEqual(bootstrapAdmin)
    const key = record(sqlite.query("SELECT * FROM api_keys WHERE id = 'reference-key'").get())
    const user = record(sqlite.query("SELECT id,is_admin FROM users WHERE username = 'reference-fixture'").get())
    expect(user.id).not.toBe(bootstrapAdmin.id)
    expect(user.is_admin).toBe(0)
    expect(key.user_id).toBe(user.id)
    const fileKey = "dumps/v1/reference-key/2026100700/real-migration-dump.resp.up.gz"
    const capture = { version: 1, capture: { exchanges: [], response: { body: { encoding: "utf8", data: "fixture-output" }, complete: true, error: null } } }
    const objects = new Map([[fileKey, gzipSync(JSON.stringify(capture))]])
    const id = "real-migration-dump"
    sqlite.query("INSERT INTO spilled_files(file_key,owner_kind,owner_key,state,collect_after) VALUES(?,?,?,?,?)")
      .run(fileKey, "dump-response-upstream", JSON.stringify(["reference-key", id]), "staged", 1)
    sqlite.query("INSERT INTO dump_records(key_id,id,created_at,upstream_id,meta_json,request_headers_json,response_headers_json,request_body_descriptor,response_body_descriptor,response_upstream_body_descriptor) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("reference-key", id, 1, "custom:reference-fixture", JSON.stringify({ id, startedAt: 0, completedAt: 1, method: "POST", path: "/v1/chat/completions", status: 200, model: seed.model, inputTokens: 1, outputTokens: 1, requestBytes: 0, responseBytes: 14, durationMs: 1, error: null, targetApi: null }), "[]", "[]", null, null, JSON.stringify({ key: fileKey, type: "capture" }))
    const readback = await readReferenceStorage(db, bucketFixture(objects))
    expect(readback.rows).toHaveLength(1)
    expect(readback.objects).toHaveLength(1)
    expect(readback.objects[0]?.json).toEqual(capture)
    expect(readback.files[0]?.state).toBe("owned")
    expect(readback.files[0]?.collect_after).toBeNull()
    expect(readback.ownershipIssues).toEqual([])
    expect(readback.historyCounts).toEqual({ responses_snapshots: 0, responses_items: 0 })
    expect(Object.keys(readback.tables).sort()).toEqual(["performance_buckets", "performance_summary", "responses_items", "responses_snapshots", "usage", "usage_requests"])
  } finally { sqlite.close() }
})

function bucketFixture(objects: Map<string, Buffer>) {
  return {
    async list({ cursor }: { limit: number; cursor?: string }) {
      const entries = [...objects.entries()]
      const index = Number(cursor ?? 0)
      return { truncated: index + 1 < entries.length, cursor: String(index + 1), objects: entries.slice(index, index + 1).map(([key, value]) => ({ key, size: value.length })) }
    },
    async get(key: string) { const bytes = objects.get(key); return bytes ? { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer } } : null },
  }
}
function addDump(sqlite: Database, objects: Map<string, Buffer>, type = "capture", content: unknown = { version: 1, capture: { exchanges: [], response: { body: { encoding: "base64", data: "/wA=" }, complete: true, error: null } } }) {
  const descriptor = { key: "dumps/v1/key/2026100700/dump.resp.up.gz", type }
  objects.set(descriptor.key, gzipSync(JSON.stringify(content)))
  sqlite.query("INSERT INTO dump_records VALUES(?,?,?,?,?,?,?,?,?,?)").run("key", "dump", 1, "custom:fixture", '{"id":"dump","status":200}', "[]", "[]", null, null, JSON.stringify(descriptor))
  sqlite.query("INSERT INTO spilled_files VALUES(?,?,?,?)").run(descriptor.key, "dump-response-upstream", '["key","dump"]', "owned")
  return descriptor.key
}

test("readback preserves R capture envelope and binary body evidence with paginated physical inventory", async () => {
  const { db, sqlite } = sqlFixture()
  const objects = new Map<string, Buffer>()
  try {
    const key = addDump(sqlite, objects)
    objects.set("unexpected/orphan.gz", gzipSync("orphan bytes"))
    const readback = await readReferenceStorage(db, bucketFixture(objects))
    expect(readback.schema).toBe("reference-native-dump-v1")
    expect(readback.rows[0]?.response_upstream_body_descriptor).toEqual({ key, type: "capture" })
    expect(readback.objects).toHaveLength(2)
    const capture = readback.objects.find(entry => entry.key === key)
    const compressed = objects.get(key)
    if (!capture || !compressed) throw new Error("Expected captured test object")
    expect(record(record(record(capture.json).capture).response).body).toEqual({ encoding: "base64", data: "/wA=" })
    expect(capture.decodedSha256).toBe(sha(Buffer.from(capture.decodedBase64, "base64")))
    expect(capture.compressedSha256).toBe(sha(compressed))
    expect(readback.ownershipIssues).toEqual([{ key: "unexpected/orphan.gz", issue: "unregistered_object" }])
    expect(readback.historyCounts).toEqual({ responses_snapshots: 0, responses_items: 0 })
  } finally { sqlite.close() }
})

test("readback fails closed for missing bodies, invalid capture versions and invalid event frames", async () => {
  for (const failure of ["missing", "version", "events", "base64"] as const) {
    const { db, sqlite } = sqlFixture()
    const objects = new Map<string, Buffer>()
    try {
      const key = failure === "events" ? addDump(sqlite, objects, "events", [{ ts: 1, frame: { type: "unknown" } }])
        : failure === "version" ? addDump(sqlite, objects, "capture", { version: 2, capture: { exchanges: [] } })
        : failure === "base64" ? addDump(sqlite, objects, "capture", { version: 1, capture: { exchanges: [], response: { body: { encoding: "base64", data: "!!!" }, complete: true, error: null } } })
        : addDump(sqlite, objects)
      if (failure === "missing") objects.delete(key)
      const message = { missing: "body missing", version: "capture version", events: "event frame", base64: "base64 body" }[failure]
      await expect(readReferenceStorage(db, bucketFixture(objects))).rejects.toThrow(message)
    } finally { sqlite.close() }
  }
})

function buildFixture(dependencyVersion?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reference-adapter-test-")))
  temporary.push(root)
  const write = (path: string, value: unknown) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value)) }
  write("package.json", { private: true })
  write("apps/platform-cloudflare/package.json", { name: "@floway-dev/platform-cloudflare", dependencies: { "@floway-dev/gateway": "workspace:*" } })
  write("apps/platform-cloudflare/entry.ts", 'import { value } from "@floway-dev/gateway"; export default { fetch() { return new Response(value) } }')
  write("packages/gateway/package.json", { name: "@floway-dev/gateway", exports: { ".": { import: "./src/index.ts" } }, dependencies: dependencyVersion ? { "fake-dependency": "^1.0.0" } : {} })
  write("packages/gateway/src/index.ts", 'export const value = "original"')
  write("packages/gateway/migrations/0001_init.sql", "CREATE TABLE fixture(id TEXT);")
  write("pnpm-lock.yaml", `lockfileVersion: '9.0'\nimporters:\n  apps/platform-cloudflare:\n    dependencies:\n      '@floway-dev/gateway': {specifier: 'workspace:*', version: 'link:../../packages/gateway'}\n  packages/gateway:\n    dependencies: ${dependencyVersion ? "\n      fake-dependency: {specifier: '^1.0.0', version: '1.0.0'}" : "{}"}\npackages:\n  fake-dependency@1.0.0:\n    resolution: {integrity: sha512-fixture}\n`)
  if (dependencyVersion) { write("node_modules/fake-dependency/package.json", { name: "fake-dependency", version: dependencyVersion, main: "index.js" }); write("node_modules/fake-dependency/index.js", "exports.value = 1") }
  return root
}

test("reference build rejects an installed dependency that differs from its lock and records the blocker", async () => {
  const root = buildFixture("1.0.1")
  await expect(buildReference(root, join(root, "out"))).rejects.toThrow("dependency")
  const receipt = record(JSON.parse(readFileSync(join(root, "out", "reference-build-receipt.json"), "utf8")))
  expect(receipt.completed).toBe(false)
  expect(receipt.dependencies).toContainEqual(expect.objectContaining({ name: "fake-dependency", expectedVersion: "1.0.0", actualVersion: "1.0.1", status: "version_mismatch" }))
})

test("reference build preserves true entrypoint and records original and transformed source identities", async () => {
  const root = buildFixture()
  const result = await buildReference(root, join(root, "out"), { transform(path: string, source: string) { return path === "packages/gateway/src/index.ts" ? { source: source.replace('"original"', '"observed"'), applied: ["test-hook"] } : { source, applied: [] } } })
  const receipt = record(JSON.parse(readFileSync(join(root, "out", "reference-build-receipt.json"), "utf8")))
  expect(receipt.completed).toBe(true)
  expect(receipt.entrypoint).toBe(join(root, "apps/platform-cloudflare/entry.ts"))
  if (!Array.isArray(receipt.transforms)) throw new Error("Expected transform receipt")
  const changed = record(receipt.transforms.find((entry: unknown) => {
    const transform = record(entry)
    return Array.isArray(transform.applied) && transform.applied.length > 0
  }))
  expect(changed.path).toBe(join(root, "packages/gateway/src/index.ts"))
  expect(changed.sha256).toBe(sha('export const value = "original"'))
  expect(changed.transformedSha256).toBe(sha('export const value = "observed"'))
  expect(result.inputs).toContainEqual(expect.objectContaining({ path: join(root, "packages/gateway/migrations/0001_init.sql") }))
  expect(readFileSync(result.bundle, "utf8")).toContain("observed")
  expect(readFileSync(join(root, "packages/gateway/src/index.ts"), "utf8")).toContain("original")
})
