import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runD10AAcceptance } from './scenarios.mjs'

const root = process.env.VNEXT_PROBE_ROOT
assert(root?.startsWith('/'), 'VNEXT_PROBE_ROOT must be an absolute verification checkout')
assert(process.env.D10A_SELECTION_JSON, 'D10A_SELECTION_JSON is required after the schema freezes')
const selection = JSON.parse(process.env.D10A_SELECTION_JSON)
const scratch = await mkdtemp(join(tmpdir(), 'd10a-workerd-'))
const entry = join(scratch, 'entry.ts')
const bundle = join(scratch, 'worker.mjs')
const template = await readFile(new URL('./workerd-entry.ts.txt', import.meta.url), 'utf8')
await writeFile(entry, template.replaceAll('__ROOT__', root))
const build = spawnSync('bun', ['build', entry, '--target=node', '--external=cloudflare:sockets', `--outfile=${bundle}`], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr || build.stdout)
const { Miniflare } = await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
const { unstable_splitSqlQuery } = await import(`${root}/vnext/node_modules/.bun/wrangler@4.97.0+01d2f64f02d20ae6/node_modules/wrangler/wrangler-dist/cli.js`)
let outboundCalls = 0
const mf = new Miniflare({
  modules: true,
  modulesRoot: scratch,
  scriptPath: bundle,
  compatibilityDate: '2025-06-01',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'd10a-local' },
  d1Persist: join(scratch, 'd1'),
  kvNamespaces: ['KV', 'IMAGE_CACHE'],
  images: { binding: 'IMAGES' },
  r2Buckets: ['FILES'],
  outboundService: async () => { outboundCalls++; throw new Error('D10A acceptance must make no external request') },
})
try {
  const db = await mf.getD1Database('DB')
  const files = (await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(name => name.endsWith('.sql')).sort()
  assert(files.some(name => name.includes('setup_leases')), 'D10A setup migration is absent; do not run acceptance against an old schema')
  for (const file of files) {
    for (const query of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${file}`, 'utf8'))) {
      await db.prepare(query).run()
    }
  }
  const sql = {
    first: (query, binds) => db.prepare(query).bind(...binds).first(),
    run: (query, binds) => db.prepare(query).bind(...binds).run(),
  }
  const fixtureOrigin = (await mf.ready).origin
  await runD10AAcceptance({
    runtime: 'production Worker + temporary real workerd D1',
    fixtureOrigin,
    selection,
    expectedWebsockets: true,
    atomicConsume: async input => {
      const response = await mf.dispatchFetch(`${fixtureOrigin}/__fixture/d10-atomic-consume`, {
        method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(input),
      })
      assert.equal(response.status, 200, 'fixture atomic consume failed')
      return response.json()
    },
    sql,
    dispatch: async request => mf.dispatchFetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    }),
    directDispatch: async request => mf.dispatchFetch(`${fixtureOrigin}/__fixture/direct-app${new URL(request.url).pathname}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    }),
    scanLogs: async secrets => {
      const response = await mf.dispatchFetch('http://d10.fixture.invalid/__fixture/d10-log-scan', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secrets }),
      })
      assert.equal(response.status, 200, 'fixture log observer failed')
      return (await response.json()).leaked ? 'leak' : ''
    },
  })
  assert.equal(outboundCalls, 0, "setup flow made an upstream request")
} finally {
  await mf.dispose()
}
console.log(JSON.stringify({ fixture: 'D10A workerd D1', scratch, complete: true }))
