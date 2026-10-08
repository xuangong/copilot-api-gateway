import { D1Repo } from "__ROOT__/vnext/apps/platform-cloudflare/src/d1-repo.ts"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const equal = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), message)
const fixture = (id, ownerId) => ({
  id, ownerId, provider: "claude-code", name: "before", enabled: true, sortOrder: 0,
  config: {}, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
  state: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", quota: 1 }, createdAt: "same", updatedAt: "same",
})
function observe(db, hooks = {}) {
  const statements = []
  let reads = 0
  const wrap = (statement, sql) => ({
    bind(...values) { return wrap(statement.bind(...values), sql) },
    async first(...args) {
      statements.push(sql)
      const fullRead = sql.startsWith("SELECT") && sql.includes("created_at") && sql.includes("FROM upstreams")
      if (fullRead) {
        reads++
        await hooks.beforeRead?.(reads)
      }
      const row = await statement.first(...args)
      if (fullRead) await hooks.afterRead?.(reads)
      return row
    },
    all(...args) { statements.push(sql); return statement.all(...args) },
    run(...args) { statements.push(sql); return statement.run(...args) },
  })
  return {
    statements,
    db: { prepare(sql) { return wrap(db.prepare(sql), sql) }, batch(statements) { return db.batch(statements) } },
  }
}
async function errorName(promise) {
  try { await promise; return "NO_ERROR" } catch (error) { return error.name }
}
export default {
  async fetch(_request, env) {
    try {
      const db = env.DB
      const repo = new D1Repo(db)
      const results = {}
      const legacy = await db.prepare("SELECT state_json, config_json, credential_generation FROM upstreams WHERE id = 'legacy'").first()
      equal(legacy, { state_json: '{ "refreshToken": "synthetic-legacy" }', config_json: '{ "safe": true }', credential_generation: 0 }, "Migration changed legacy bytes")
      results.legacyBytesPreserved = true
      for (const ownerId of [undefined, "owner"]) {
        const owner = ownerId ?? "ownerless"
        const id = `replacement-${owner}`
        const created = await repo.upstreams.createIfAbsent(fixture(id, ownerId))
        assert(created.credentialGeneration === 0, "Creation generation")
        const replaced = await repo.upstreams.replaceCredentials(created, { config: created.config, state: created.state })
        assert(replaced.credentialGeneration === 1 && replaced.catalogGeneration === 1, "Replacement generation")
        assert(await errorName(repo.upstreams.saveState(id, () => ({ stale: true }), created)) === "UpstreamReplacedError", "Stale initial read")
        await repo.upstreams.save(replaced)
        const imported = await repo.upstreams.getById(id)
        assert(imported.credentialGeneration === 2 && imported.catalogGeneration === 2, "Same-byte full save generation")
        const patched = await repo.upstreams.patchMetadata(imported, row => ({ ...row, config: { baseUrl: "https://example.invalid" } }))
        assert(patched.credentialGeneration === 2 && patched.catalogGeneration === 3, "Metadata moved credential generation")
        await repo.upstreams.saveState(id, () => ({ quota: 9 }), imported)
        results[`${owner}:replacementAndMetadata`] = true
        for (const noOp of [false, true]) {
          const raceId = `race-${owner}-${noOp}`
          const original = await repo.upstreams.createIfAbsent(fixture(raceId, ownerId))
          const watched = observe(db, { afterRead: async read => {
            if (read === 1) await repo.upstreams.replaceCredentials(original, { config: original.config, state: original.state })
          } })
          let updates = 0
          const raced = new D1Repo(watched.db)
          const name = await errorName(raced.upstreams.saveState(raceId, current => { updates++; return noOp ? current : { stale: true } }, original))
          assert(name === "UpstreamReplacedError" && updates === 1, "Post-read same-byte race accepted")
          equal((await repo.upstreams.getById(raceId)).state, original.state, "Race overwrote replacement")
          results[`${owner}:${noOp ? "noOp" : "write"}Race`] = name
        }
        const retryId = `retry-${owner}`
        const original = await repo.upstreams.createIfAbsent(fixture(retryId, ownerId))
        const watched = observe(db, {
          afterRead: async read => {
            if (read === 1) await repo.upstreams.saveState(retryId, () => ({ quota: 8 }))
          },
          beforeRead: async read => {
            if (read === 2) {
              const current = await repo.upstreams.getById(retryId)
              await repo.upstreams.replaceCredentials(current, { config: current.config, state: current.state })
            }
          },
        })
        let updates = 0
        const retry = new D1Repo(watched.db)
        const name = await errorName(retry.upstreams.saveState(retryId, () => { updates++; return { stale: true } }, original))
        assert(name === "UpstreamReplacedError" && updates === 1, "Retry crossed credential generation")
        equal((await repo.upstreams.getById(retryId)).state, { quota: 8 }, "Retry overwrote winner")
        results[`${owner}:retryFence`] = name
      }
      const original = await repo.upstreams.createIfAbsent(fixture("counted"))
      const watched = observe(db)
      const counted = new D1Repo(watched.db)
      await counted.upstreams.saveState(original.id, () => ({ quota: 3 }), original)
      assert(watched.statements.length === 2, "Write added SQL roundtrips")
      watched.statements.length = 0
      await counted.upstreams.saveState(original.id, current => current, original)
      assert(watched.statements.length === 2, "No-op added SQL roundtrips")
      results.sqlStatementsPerSaveState = 2
      await db.prepare("INSERT INTO upstreams(id,provider,name,created_at,updated_at)VALUES('raw','claude-code','raw','same','same')").run()
      assert((await repo.upstreams.getById("raw")).credentialGeneration === 0, "Legacy INSERT missing default")
      assert(await errorName(db.prepare("UPDATE upstreams SET credential_generation=-1 WHERE id='raw'").run()) !== "NO_ERROR", "Negative generation accepted")
      await db.prepare("UPDATE upstreams SET credential_generation=2 WHERE id='raw'").run()
      assert(await errorName(db.prepare("UPDATE upstreams SET credential_generation=1 WHERE id='raw'").run()) !== "NO_ERROR", "Decreasing generation accepted")
      results.defaultAndMonotonic = true
      return Response.json({ passed: true, results })
    } catch (error) {
      return Response.json({ passed: false, error: { name: error.name, message: error.message, stack: error.stack } }, { status: 500 })
    }
  },
}
