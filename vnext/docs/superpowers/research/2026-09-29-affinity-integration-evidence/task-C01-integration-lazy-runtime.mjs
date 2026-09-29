import assert from "node:assert/strict"
import { serve } from "bun"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
const root = process.env.VNEXT_PROBE_ROOT
assert(root)
const source = `${root}/vnext`
const { bootstrapBunPlatform } = await import(`${source}/apps/platform-bun/src/bootstrap.ts`)
const { initBackground, initSocketDial } = await import(`${source}/packages/platform/src/index.ts`)
const { getRepo } = await import(`${source}/packages/gateway/src/repo/index.ts`)
const { app } = await import(`${source}/packages/gateway/src/app.ts`)
const scratch = await mkdtemp(`${tmpdir()}/c01-lazy-runtime-`)
const { db } = bootstrapBunPlatform({ dbPath: `${scratch}/fixture.sqlite`, filesRoot: `${scratch}/files` })
const pending = []
initBackground({ waitUntil: p => pending.push(p) })
initSocketDial(async () => { throw new Error("External socket blocked") })
const now = new Date().toISOString(), calls = [], cases = []
for (const id of ["owner", "foreign"]) await db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").bind(id, id, `${id}@example.invalid`, now).run()
for (const id of ["ordinary", "moved", "changed"]) await db.prepare("INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)").bind(id, id, `raw-${id}`, now, "owner").run()
const repo = getRepo()
const upstream = serve({ hostname: "127.0.0.1", port: 0, fetch: async req => {
  const body = await req.json()
  calls.push(body)
  const text = JSON.stringify(body.input)
  if (text.includes("move-owner")) await db.prepare("UPDATE api_keys SET owner_id = ? WHERE id = ?").bind("foreign", "moved").run()
  if (text.includes("replace-config")) {
    const old = await repo.upstreams.getById("up_lazy")
    await repo.upstreams.save({ ...old, config: { ...old.config, headers: { "x-synthetic-revision": "new" } } })
  }
  return Response.json({ id: `resp_lazy_${calls.length}`, object: "response", model: body.model, status: "completed", error: null, output: text.includes("plain-text")
    ? [{ type: "message", id: "msg_plain", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic answer", annotations: [] }] }]
    : text.includes("replace-config") ? [{ type: "compaction", id: "cmp_lazy", encrypted_content: "synthetic-opaque" }] : [{ type: "reasoning", id: "rs_lazy", summary: [{ type: "summary_text", text: "Synthetic thought" }], encrypted_content: "synthetic-opaque" }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
} })
await repo.upstreams.save({ id: "up_lazy", ownerId: "owner", provider: "custom", name: "up_lazy", enabled: true, sortOrder: 0, config: { name: "up_lazy", baseUrl: `http://127.0.0.1:${upstream.port}`, authStyle: "none", endpoints: ["responses"], models: ["synthetic-model"] }, state: {}, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], createdAt: now, updatedAt: now })
const server = serve({ hostname: "127.0.0.1", port: 0, fetch: req => app.fetch(req, {}) })
const request = async (key, input) => {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: "POST", headers: { authorization: `Bearer raw-${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "up_lazy/synthetic-model", input, stream: false }) })
  const body = await response.json()
  return { status: response.status, body }
}
try {
  const ordinary = await request("ordinary", "plain-text")
  assert.equal(ordinary.status, 200)
  const secret = await db.prepare("SELECT affinity_secret, affinity_key_id, affinity_version FROM api_keys WHERE id = ?").bind("ordinary").first()
  assert.deepEqual(secret, { affinity_secret: null, affinity_key_id: null, affinity_version: null })
  cases.push("ordinary-no-secret-initialization")
  const moved = await request("moved", "move-owner")
  assert(moved.status >= 400, "Key ownership changed before first signature must fail closed")
  assert(!JSON.stringify(moved.body).includes("synthetic-opaque"), "Failure leaked opaque payload")
  cases.push("key-owner-change-before-first-signature-rejected")
  const changed = await request("changed", "replace-config")
  if (changed.status === 200) {
    assert(changed.body.output[0].encrypted_content.startsWith("vnext-affinity:"))
    const count = calls.length
    const replay = await request("changed", changed.body.output)
    assert.equal(replay.status, 503)
    assert.equal(calls.length, count)

  } else assert(changed.status >= 400)
  cases.push("captured-old-target-never-authorizes-replacement-replay")
  await Promise.all(pending)
  console.log(JSON.stringify({ passed: true, runtime: "actual authenticated Bun/HTTP/SQLite lazy affinity", cases, calls: calls.length, scratch }))
} finally { server.stop(true); upstream.stop(true) }
