import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"

const here = dirname(fileURLToPath(import.meta.url))
const vnext = join(here, "../../..")
let dir: string
let mf: Miniflare
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>
const start = "2026-09-01T00"
const ids = Array.from({ length: 1001 }, (_, i) => `key-${String(i).padStart(4, "0")}`)

async function startFixture() {
  dir = mkdtempSync(join(process.env["D08_CAPACITY_FIXTURE_ROOT"] ?? tmpdir(), "usage-capacity-workerd-"))
  const entry = join(dir, "entry.ts")
  const bundle = join(dir, "worker.mjs")
  writeFileSync(entry, `
    import { app } from ${JSON.stringify(join(vnext, "packages/gateway/src/app.ts"))}
    import { initRepo } from ${JSON.stringify(join(vnext, "packages/gateway/src/repo/index.ts"))}
    import { buildSharedRepo } from ${JSON.stringify(join(vnext, "packages/gateway/src/repo/shared/repos.ts"))}
    export default { async fetch(request, env) {
      const calls = []
      const prepare = (sql, binds) => { calls.push({sql, binds: binds.length}); return env.DB.prepare(sql).bind(...binds) }
      initRepo(buildSharedRepo({
        all: async (sql, binds) => (await prepare(sql, binds).all()).results,
        first: async (sql, binds) => prepare(sql, binds).first(),
        run: async (sql, binds) => ({changes: (await prepare(sql, binds).run()).meta.changes}),
      }))
      const response = await app.fetch(request, env)
      // Auth/configuration prewarm are deliberately excluded from route budgets.
      const owned = calls.filter(c => /FROM usage(?:_requests)? WHERE/.test(c.sql)
        || /AS keyId/.test(c.sql) || /FROM api_keys WHERE owner_id =/.test(c.sql)
        || /FROM key_assignments WHERE user_id =/.test(c.sql))
      const result = new Response(response.body, response)
      result.headers.set("x-route-statements", String(owned.length))
      result.headers.set("x-route-max-binds", String(Math.max(0,...owned.map(c => c.binds))))
      return result
    }}
  `)
  const build = Bun.spawnSync(["bun", "build", entry, "--target=node", "--external=cloudflare:sockets", `--outfile=${bundle}`], { cwd: vnext })
  if (build.exitCode !== 0) throw new Error(new TextDecoder().decode(build.stderr))
  mf = new Miniflare({ modules: true, modulesRoot: dir, scriptPath: bundle, host: "127.0.0.1", port: 0,
    compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "usage-capacity" }, d1Persist: join(dir, "d1") })
  db = await mf.getD1Database("DB")
  const migrationDir = join(vnext, "packages/gateway/migrations")
  for (const file of readdirSync(migrationDir).filter(file => file.endsWith(".sql")).sort()) {
    for (const sql of unstable_splitSqlQuery(readFileSync(join(migrationDir, file), "utf8"))) await db.prepare(sql).run()
  }
  for (const [id, email] of [["owner", null], ["viewer", null], ["admin", "test@local.dev"]] as const) {
    await db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").bind(id, id, email, start).run()
    await db.prepare("INSERT INTO user_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)").bind(`ses_capacity_${id}`, id, start, "2099-01-01T00:00:00.000Z").run()
  }
  // One JSON bind seeds the same full scope without concealing a query limit.
  await db.prepare("INSERT INTO api_keys(id,name,key,created_at,owner_id) SELECT value,value,'private-'||value,?,'owner' FROM json_each(?)").bind(start, JSON.stringify(ids)).run()
  await db.prepare("INSERT INTO key_assignments(key_id,user_id,assigned_by,assigned_at) SELECT value,'viewer','owner',? FROM json_each(?)").bind(start, JSON.stringify(ids)).run()
  await db.prepare("INSERT INTO usage_requests(key_id,incoming_model,model,upstream,model_key,client,hour,requests) SELECT value,'alias','model',NULL,'price','client',?,2 FROM json_each(?)").bind(start, JSON.stringify(ids)).run()
  for (const [dimension, tokens, price] of [["input",100,0.125],["output",9,0.00000003125],["input_cache_read",30,null],["input_cache_write",4,0],["input_image",2,null],["output_image",3,null]] as const) {
    await db.prepare("INSERT INTO usage(key_id,incoming_model,model,upstream,model_key,client,hour,dimension,tokens,unit_price) SELECT value,'alias','model',NULL,'price','client',?,?,?,? FROM json_each(?)").bind(start,dimension,tokens,price,JSON.stringify(ids)).run()
  }
  const people = Array.from({ length: 400 }, (_, i) => `person-${String(i).padStart(3, "0")}`)
  await db.prepare("INSERT INTO key_assignments(key_id,user_id,assigned_by,assigned_at) SELECT 'key-0000',value,'owner',? FROM json_each(?)").bind(start,JSON.stringify([...people,"owner"])).run()
}

async function request(who: string, path: string, statements: number) {
  const response = await mf.dispatchFetch((await mf.ready).origin + path, { headers: { authorization: `Bearer ses_capacity_${who}` } })
  expect(response.status).toBe(200)
  expect(Number(response.headers.get("x-route-statements"))).toBe(statements)
  expect(Number(response.headers.get("x-route-max-binds"))).toBeLessThanOrEqual(3)
  return response
}

async function assertCompleteDetail() {
  let main: Array<Record<string, unknown>> | undefined
  for (const [from, end] of [[start,"2026-09-29T00"],["2026-06-04T00","2026-09-29T00"]]) {
    const response = await request("viewer", `/api/token-usage?start=${from}&end=${end}`, 5)
    const rows = await response.json() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1001)
    expect(rows.map(row => row.keyId)).toEqual(ids)
    expect(rows.every(row => row.requests === 2)).toBe(true)
    for (const row of rows) {
      expect(row).toEqual({ keyId: row.keyId, keyName: row.keyId, incomingModel: "alias", model: "model", client: "client", hour: start,
        requests: 2, tokens: { input: 100, output: 9, input_cache_read: 30, input_cache_write: 4, input_image: 2, output_image: 3 },
        cost: (100 * 0.125 + 9 * 0.00000003125 + 30 * 0.125 + 2 * 0.125 + 3 * 0.00000003125) / 1e6 })
    }
    if (main === undefined) main = rows
    else expect(rows).toEqual(main)
  }
  const admin = await request("admin", `/api/token-usage?start=${start}&end=2026-09-29T00`, 3)
  const rows = await admin.json() as Array<Record<string, unknown>>
  if (!main) throw new Error("Main fixture missing")
  expect(rows).toEqual(main.map(row => ({ ...row, ownerId: "owner", ownerName: "owner" })))
}

async function assertCompleteParticipants() {
  const expected = await db.prepare("SELECT user_id FROM key_assignments WHERE key_id='key-0000'").all<{ user_id: string }>()
  const admin = await request("admin", "/api/token-usage/participants", 2)
  const rows = await admin.json() as Array<{ keyId: string; sharedWith: Array<{ id: string; name: string }> }>
  const legacyKeys = await db.prepare("SELECT id FROM api_keys ORDER BY created_at").all<{ id: string }>()
  const completeRoster = expected.results.map((row: { user_id: string }) => ({
    id: row.user_id, name: row.user_id === "owner" || row.user_id === "viewer" ? row.user_id : row.user_id.slice(0, 8),
  }))
  expect(rows).toEqual(legacyKeys.results.map((key: { id: string }) => ({
    keyId: key.id, ownerId: "owner", ownerName: "owner",
    sharedWith: key.id === "key-0000" ? completeRoster : [{ id: "viewer", name: "viewer" }],
  })))
  const first = rows.find(row => row.keyId === "key-0000")
  expect(first?.sharedWith.map(person => person.id)).toEqual(expected.results.map((row: { user_id: string }) => row.user_id))
  expect(first?.sharedWith).toHaveLength(402)
  expect(first?.sharedWith.find(person => person.id === "person-000")?.name).toBe("person-0")
  const viewer = await request("viewer", "/api/token-usage/participants", 3)
  const hidden = await viewer.json() as Array<{ sharedWith: unknown[] }>
  const legacyAssignments = await db.prepare("SELECT key_id FROM key_assignments WHERE user_id='viewer'").all<{ key_id: string }>()
  expect(hidden).toEqual(legacyAssignments.results.map((key: { key_id: string }) => ({
    keyId: key.key_id, ownerId: "owner", ownerName: "owner", sharedWith: [],
  })))
}

// Bun 1.3's third consecutive Miniflare fixture can stall during startup.
// An isolated process also keeps the migration/startup budget local to this test.
const childMarker = "D08_CAPACITY_WORKER_TEST_CHILD"
const completionMarker = "D08_CAPACITY_ASSERTIONS_AND_DISPOSAL_COMPLETE"

test.serial("actual workerd returns complete 1001-key detail and 402-person rosters within fixed SQL budgets", async () => {
  if (process.env[childMarker] === "1") {
    try {
      await startFixture()
      await assertCompleteDetail()
      await assertCompleteParticipants()
    } finally {
      try { await mf?.dispose() } finally {
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    }
    console.log(completionMarker)
    return
  }

  const fixtureRoot = mkdtempSync(join(tmpdir(), "usage-capacity-process-"))
  const child = spawn(process.execPath, ["test", import.meta.path], {
    cwd: vnext, env: { ...process.env, [childMarker]: "1", D08_CAPACITY_FIXTURE_ROOT: fixtureRoot },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
  const stopGroup = () => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, "SIGKILL") } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    }
  }
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; stopGroup() }, 50000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    // Preserve the child assertion count and failures in the normal CI log.
    process.stdout.write(stdout)
    process.stderr.write(stderr)
    expect(timedOut).toBe(false)
    expect(code).toBe(0)
    expect(stdout).toContain(completionMarker)
  } finally {
    clearTimeout(timeout)
    try { stopGroup() } finally { rmSync(fixtureRoot, { recursive: true, force: true }) }
  }
}, process.env[childMarker] === "1" ? 40000 : 60000)
