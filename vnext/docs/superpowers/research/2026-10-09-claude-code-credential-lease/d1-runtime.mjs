import { readdir, readFile, writeFile, mkdtemp } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import assert from "node:assert/strict"

const root = process.env.VNEXT_PROBE_ROOT
assert(root, "VNEXT_PROBE_ROOT required")
const require = createRequire(`${root}/vnext/apps/platform-cloudflare/package.json`)
const { Miniflare } = await import(require.resolve("miniflare"))
const { unstable_splitSqlQuery } = await import(require.resolve("wrangler"))
const scratch = await mkdtemp(`${tmpdir()}/credential-generation-d1-`)
const entry = `${scratch}/worker.mjs`
const bundle = `${scratch}/bundle.mjs`
await writeFile(entry, (await readFile(new URL("./d1-worker.mjs", import.meta.url), "utf8")).replaceAll("__ROOT__", root))
const build = spawnSync("bun", ["build", entry, "--target=node", `--outfile=${bundle}`], { cwd: root, encoding: "utf8" })
assert.equal(build.status, 0, build.stderr)
const mf = new Miniflare({ modules: true, modulesRoot: scratch, scriptPath: bundle, compatibilityDate: "2026-06-01", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "credential-generation" } })
try {
  const db = await mf.getD1Database("DB")
  const migrations = []
  for (const file of (await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(file => file.endsWith(".sql")).sort()) {
    if (file === "0022_upstream_credential_generation.sql") {
      await db.prepare("INSERT INTO upstreams(id,provider,name,config_json,state_json,created_at,updated_at)VALUES('legacy','claude-code','legacy',?,?,'same','same')")
        .bind('{ "safe": true }', '{ "refreshToken": "synthetic-legacy" }').run()
    }
    for (const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${file}`, "utf8"))) await db.prepare(sql).run()
    migrations.push(file)
  }
  const response = await mf.dispatchFetch("http://local/")
  const body = await response.text()
  assert.equal(response.status, 200, body)
  const result = JSON.parse(body)
  assert.equal(result.passed, true)
  console.log(JSON.stringify({ runtime: "actual local workerd+D1Repo", migrations, ...result, scratch }))
} finally {
  await mf.dispose()
}
