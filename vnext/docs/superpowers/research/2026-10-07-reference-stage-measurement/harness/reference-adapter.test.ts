import { afterEach, expect, test } from "bun:test"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
    const bound = (values: SQLQueryBindings[]) => ({ async run() { return statement.run(...values) }, async first<T>() { return statement.get(...values) as T | null }, async all<T>() { return { results: statement.all(...values) as T[] } } })
    return { ...bound([]), bind(...values: SQLQueryBindings[]) { return bound(values) } }
  } }
}
function sqlFixture() {
  const sqlite = new Database(":memory:")
  sqlite.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE api_keys(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE, server_secret TEXT NOT NULL CHECK(length(server_secret) = 64 AND server_secret NOT GLOB '*[^0-9a-f]*'), created_at TEXT NOT NULL, dump_retention_seconds INTEGER, responses_retention_seconds INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE upstreams(id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, config_json TEXT NOT NULL, proxy_fallback_list_json TEXT NOT NULL, flag_overrides TEXT NOT NULL DEFAULT '[]', enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, config_version INTEGER DEFAULT 1, state_json TEXT, disabled_public_model_ids TEXT DEFAULT '[]', model_prefix_json TEXT, models_cache_json TEXT, hue INTEGER NOT NULL CHECK(hue >= 0 AND hue < 360), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE dump_records(key_id TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL, upstream_id TEXT, meta_json TEXT NOT NULL, request_headers_json TEXT NOT NULL, response_headers_json TEXT, request_body_descriptor TEXT, response_body_descriptor TEXT, response_upstream_body_descriptor TEXT);
    CREATE TABLE spilled_files(file_key TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_key TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE usage(metric TEXT, amount TEXT); CREATE TABLE usage_requests(requests INTEGER);
    CREATE TABLE performance_summary(requests INTEGER); CREATE TABLE performance_buckets(count INTEGER);
    CREATE TABLE responses_snapshots(id TEXT); CREATE TABLE responses_items(id TEXT);
  `)
  return { db: sqliteBoundary(sqlite), sqlite }
}
const referenceRoot = process.env.REFERENCE_SOURCE_ROOT ?? "/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix/.superpowers/sdd/2026-10-07-reference-stage-measurement/reference-source"
const seed = { referenceRoot, baseUrl: "http://127.0.0.1:49999", apiKey: "isolated-key", fixtureSecret: "fixture-secret", dump: true, model: "bench-chat-success" }

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
    expect(key.dump_retention_seconds).toBe(3600)
    const config = record(JSON.parse(String(upstream.config_json)))
    expect(config.baseUrl).toBe(seed.baseUrl)
    expect(config.modelsFetch).toEqual({ enabled: false })
    expect(config.endpoints).toEqual({ openaiChatCompletions: {} })
    expect(config.models).toEqual([{ kind: "chat", upstreamModelId: seed.model, publicModelId: seed.model, endpoints: { openaiChatCompletions: {} } }])
    expect(config.ingressHeadersRules).toEqual([])
    expect(JSON.parse(String(upstream.proxy_fallback_list_json))).toEqual([{ id: "direct_fetch" }])
    expect(JSON.parse(String(upstream.flag_overrides))).toEqual({})
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
    const flagColumn = sqlite.query("PRAGMA table_info(upstreams)").all().map(record).find(column => column.name === "flag_overrides")
    expect(flagColumn?.dflt_value).toBe("'[]'")
    await seedReference(db, seed)
    expect(sqlite.query("SELECT json_type(flag_overrides) AS kind FROM upstreams WHERE id = 'custom:reference-fixture'").get()).toEqual({ kind: "object" })
    expect(sqlite.query("SELECT flag_overrides FROM upstreams WHERE id = 'custom:reference-fixture'").get()).toEqual({ flag_overrides: "{}" })
    const { SqlRepo } = await import(join(referenceRoot, "packages/gateway/src/repo/sql.ts"))
    const { readUpstreamModelsSnapshotAndScheduleRefresh } = await import(join(referenceRoot, "packages/gateway/src/data-plane/providers/models-cache.ts"))
    const native = await new SqlRepo(db).upstreams.getById("custom:reference-fixture")
    expect(native.enabled).toBe(true)
    expect(native.configVersion).toBe(1)
    expect(native.state).toBe(null)
    expect(native.disabledPublicModelIds).toEqual([])
    expect(native.modelPrefix).toBe(null)
    const scheduled: unknown[] = []
    const snapshot = readUpstreamModelsSnapshotAndScheduleRefresh({ ...native, upstreamId: native.id }, (target: unknown) => scheduled.push(target))
    expect(snapshot.models.map((model: { id: string }) => model.id)).toEqual([seed.model])
    expect(snapshot.models[0].kind).toBe("chat")
    expect(snapshot.models[0].endpoints).toEqual({ openaiChatCompletions: {} })
    expect(snapshot.models[0].enabledFlags instanceof Set).toBe(true)
    expect(snapshot.lastError).toBe(null)
    expect(scheduled).toEqual([])
    expect(sqlite.query("SELECT upstream_ids FROM users WHERE username = 'reference-fixture'").get()).toEqual({ upstream_ids: null })
    expect(sqlite.query("SELECT upstream_ids FROM api_keys WHERE id = 'reference-key'").get()).toEqual({ upstream_ids: null })
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


test("reference build uses the named package owner above module scope manifests", async () => {
  const root = buildFixture("1.0.0")
  const write = (path: string, value: unknown) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value)) }
  write("packages/gateway/src/index.ts", 'import { value } from "fake-dependency"; export { value }')
  write("node_modules/fake-dependency/package.json", { name: "fake-dependency", version: "1.0.0", main: "esm/index.js" })
  write("node_modules/fake-dependency/esm/package.json", { type: "module" })
  write("node_modules/fake-dependency/esm/index.js", 'export const value = "nested-scope"')
  const result = await buildReference(root, join(root, "out"))
  expect(readFileSync(result.bundle, "utf8")).toContain("nested-scope")
  expect(result.inputs).toContainEqual(expect.objectContaining({ path: join(root, "node_modules/fake-dependency/esm/package.json") }))
})


test("reference build accepts a locked package self export without inventing a dependency edge", async () => {
  const root = buildFixture("1.0.0")
  const write = (path: string, value: unknown) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value)) }
  write("packages/gateway/src/index.ts", 'import { value } from "fake-dependency"; export { value }')
  write("node_modules/fake-dependency/package.json", { name: "fake-dependency", version: "1.0.0", type: "module", exports: { ".": "./index.js", "./value": "./value.js" } })
  write("node_modules/fake-dependency/index.js", 'export { value } from "fake-dependency/value"')
  write("node_modules/fake-dependency/value.js", 'export const value = "self-export"')
  const result = await buildReference(root, join(root, "out"))
  expect(readFileSync(result.bundle, "utf8")).toContain("self-export")
})


test("reference build still rejects a hoisted locked package without a declared dependency edge", async () => {
  const root = buildFixture("1.0.0")
  const write = (path: string, value: unknown) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value)) }
  write("packages/gateway/src/index.ts", 'import { value } from "fake-dependency"; export { value }')
  write("node_modules/fake-dependency/index.js", 'exports.value = require("hoisted-dependency").value')
  write("node_modules/hoisted-dependency/package.json", { name: "hoisted-dependency", version: "1.0.0", main: "index.js" })
  write("node_modules/hoisted-dependency/index.js", 'exports.value = "hoisted"')
  write("pnpm-lock.yaml", readFileSync(join(root, "pnpm-lock.yaml"), "utf8") + "  hoisted-dependency@1.0.0: {}\n")
  await expect(buildReference(root, join(root, "out"))).rejects.toThrow("Bundle failed")
  const receipt = record(JSON.parse(readFileSync(join(root, "out", "reference-build-receipt.json"), "utf8")))
  expect(receipt.completed).toBe(false)
})


function privateHoistFixture() {
  const root = buildFixture("1.0.0")
  const write = (path: string, value: unknown) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value)) }
  const packageRoot = "node_modules/.pnpm/fake-dependency@1.0.0/node_modules/fake-dependency"
  mkdirSync(dirname(join(root, packageRoot)), { recursive: true })
  renameSync(join(root, "node_modules/fake-dependency"), join(root, packageRoot))
  symlinkSync(join(root, packageRoot), join(root, "node_modules/fake-dependency"))
  write("packages/gateway/src/index.ts", 'import { value } from "fake-dependency"; export { value }')
  write(packageRoot + "/index.js", 'exports.value = require("hoisted-dependency").value')
  write("node_modules/.pnpm/hoisted-dependency@1.0.0/node_modules/hoisted-dependency/package.json", { name: "hoisted-dependency", version: "1.0.0", main: "index.js" })
  write("node_modules/.pnpm/hoisted-dependency@1.0.0/node_modules/hoisted-dependency/index.js", 'exports.value = "private-hoist"')
  mkdirSync(join(root, "node_modules/.pnpm/node_modules"), { recursive: true })
  symlinkSync(join(root, "node_modules/.pnpm/hoisted-dependency@1.0.0/node_modules/hoisted-dependency"), join(root, "node_modules/.pnpm/node_modules/hoisted-dependency"))
  write("node_modules/.modules.yaml", "packageManager: pnpm@10.24.0\nnodeLinker: isolated\nvirtualStoreDir: .pnpm\nhoistPattern: ['*']\npublicHoistPattern: []\nhoistedDependencies:\n  hoisted-dependency@1.0.0:\n    hoisted-dependency: private\n")
  write("pnpm-lock.yaml", readFileSync(join(root, "pnpm-lock.yaml"), "utf8") + "  bridge@1.0.0: {}\n  hoisted-dependency@1.0.0: {}\nsnapshots:\n  fake-dependency@1.0.0:\n    dependencies: {bridge: 1.0.0}\n  bridge@1.0.0:\n    dependencies: {hoisted-dependency: 1.0.0}\n  hoisted-dependency@1.0.0: {}\n")
  return { root, write }
}

test("reference build freezes and labels an existing pnpm private hoist backed by the importer lock closure", async () => {
  const { root } = privateHoistFixture()
  await buildReference(root, join(root, "out"))
  const receipt = record(JSON.parse(readFileSync(join(root, "out/reference-build-receipt.json"), "utf8")))
  expect(receipt.resolutions).toContainEqual(expect.objectContaining({ specifier: "hoisted-dependency", edgeKind: "undeclared-hoisted", expectedVersion: "1.0.0", lockPath: ["fake-dependency@1.0.0", "bridge@1.0.0", "hoisted-dependency@1.0.0"] }))
  expect(receipt.inputs).toContainEqual(expect.objectContaining({ path: join(root, "node_modules/.modules.yaml") }))
})

test("reference build rejects private hoists with invalid installation evidence or lock ancestry", async () => {
  for (const failure of ["metadata", "ancestry", "version", "physical"] as const) {
    const { root, write } = privateHoistFixture()
    if (failure === "metadata") write("node_modules/.modules.yaml", "packageManager: pnpm@10.34.5\n")
    if (failure === "ancestry") write("pnpm-lock.yaml", readFileSync(join(root, "pnpm-lock.yaml"), "utf8").replace("dependencies: {hoisted-dependency: 1.0.0}", "dependencies: {}"))
    if (failure === "version") write("node_modules/.pnpm/hoisted-dependency@1.0.0/node_modules/hoisted-dependency/package.json", { name: "hoisted-dependency", version: "1.0.1", main: "index.js" })
    if (failure === "physical") {
      rmSync(join(root, "node_modules/.pnpm/node_modules/hoisted-dependency"))
      write("node_modules/hoisted-dependency/package.json", { name: "hoisted-dependency", version: "1.0.0", main: "index.js" })
      write("node_modules/hoisted-dependency/index.js", 'exports.value = "wrong-physical-hoist"')
    }
    await expect(buildReference(root, join(root, "out"))).rejects.toThrow()
  }
})


test("reference seed native Custom fetch dispatches the exact fixture URL and request", async () => {
  const { customFetchOpenAIChatCompletions } = await import(join(referenceRoot, "packages/provider-custom/src/fetch.ts"))
  for (const baseUrl of [seed.baseUrl, seed.baseUrl + "/v1"]) {
    const { db, sqlite } = sqlFixture()
    try {
      await seedReference(db, { ...seed, baseUrl })
      const row = record(sqlite.query("SELECT config_json FROM upstreams WHERE id = 'custom:reference-fixture'").get())
      const config = JSON.parse(String(row.config_json))
      const body = JSON.stringify({ model: seed.model, stream: true, messages: [{ role: "user", content: "BENCH_ID:native-dispatch" }] })
      const calls: { url: string; method: string; body: unknown; headers: Headers }[] = []
      let wrapped = 0
      const response = await customFetchOpenAIChatCompletions(config, { method: "POST", body }, {
        fetcher: async (url: string, init: RequestInit) => { calls.push({ url, method: init.method ?? "", body: init.body, headers: new Headers(init.headers) }); return new Response("fixture-native", { status: 200 }) },
        wrapUpstreamCall: async (call: () => Promise<Response>) => { wrapped++; return await call() },
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe(seed.baseUrl + "/v1/chat/completions")
      expect(calls[0]!.method).toBe("POST")
      expect(calls[0]!.body).toBe(body)
      expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${seed.fixtureSecret}`)
      expect(calls[0]!.headers.get("content-type")).toBe("application/json")
      expect(wrapped).toBe(1)
      expect(await response.text()).toBe("fixture-native")
    } finally { sqlite.close() }
  }
})
