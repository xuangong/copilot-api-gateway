import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runD10AAcceptance } from './scenarios.mjs'

const root = process.env.VNEXT_PROBE_ROOT
assert(root?.startsWith('/'), 'VNEXT_PROBE_ROOT must be an absolute verification checkout')
assert(process.env.D10A_SELECTION_JSON, 'D10A_SELECTION_JSON is required after the schema freezes')
const selection = JSON.parse(process.env.D10A_SELECTION_JSON)
const scratch = await mkdtemp(join(tmpdir(), 'd10a-bun-'))
const logs = []
const original = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, console[level].bind(console)]))
for (const level of ['log', 'warn', 'error']) console[level] = (...parts) => { logs.push(parts.map(String).join(' ')) }
let db
let result
let outboundCalls = 0
globalThis.fetch = async () => { outboundCalls++; throw new Error("External fetch blocked in D10A fixture") }
try {
  const { bootstrapBunPlatform } = await import(`${root}/vnext/apps/platform-bun/src/bootstrap.ts`)
  const { initSocketDial } = await import(`${root}/vnext/packages/platform/src/index.ts`)
  const { app } = await import(`${root}/vnext/packages/gateway/src/app.ts`)
  ;({ db } = bootstrapBunPlatform({ dbPath: join(scratch, 'fixture.sqlite'), filesRoot: join(scratch, 'files') }))
  initSocketDial(async () => { outboundCalls++; throw new Error("External socket blocked in D10A fixture") })
  const present = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'setup_leases'").first()
  assert(present, 'D10A setup migration is absent; do not run acceptance against an old schema')
  const sql = {
    first: (query, binds) => db.prepare(query).bind(...binds).first(),
    run: (query, binds) => db.prepare(query).bind(...binds).run(),
  }
  const { getRepo } = await import(`${root}/vnext/packages/gateway/src/repo/index.ts`)
  const { ADMIN_EMAILS } = await import(`${root}/vnext/packages/gateway/src/shared/config/constants.ts`)
  result = await runD10AAcceptance({
    runtime: 'Bun app + temporary real SQLite',
    selection,
    expectedWebsockets: false,
    atomicConsume: async ({leaseId, statement, binds, preserveRevision}) => {
      const repo = getRepo()
      const lease = await repo.setupLeases.findById(leaseId)
      const key = await repo.apiKeys.getById(lease.keyId)
      const revision = await sql.first('SELECT revision FROM configuration_revision WHERE id = 1', [])
      await sql.run(statement, binds)
      if (preserveRevision) await sql.run('UPDATE configuration_revision SET revision = ? WHERE id = 1', [revision.revision])
      return { consumed: await repo.setupLeases.consume(lease, key.key, new Date().toISOString(), ADMIN_EMAILS) }
    },
    sql,
    dispatch: request => app.fetch(request, {}),
    scanLogs: async secrets => logs.some(line => secrets.some(secret => line.includes(secret))) ? 'leak' : '',
  })
  assert.equal(outboundCalls, 0, "setup flow made an upstream request")
} finally {
  db?.raw.close()
  for (const level of ['log', 'warn', 'error']) console[level] = original[level]
}
original.log(JSON.stringify({ fixture: 'D10A Bun SQLite', scratch, complete: true, result }))
