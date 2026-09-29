import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const root = process.env.VNEXT_PROBE_ROOT
assert(root?.startsWith('/'))
const scratch = await mkdtemp(join(tmpdir(), 'd10b-workerd-assets-'))
const entry = join(scratch, 'entry.ts')
const bundle = join(scratch, 'worker.mjs')
const template = await readFile(new URL('./workerd-entry.ts.txt', import.meta.url), 'utf8')
await writeFile(entry, template.replaceAll('__ROOT__', root))
const build = spawnSync('bun', ['build', entry, '--target=node', '--external=cloudflare:sockets', `--outfile=${bundle}`], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr || build.stdout)
const { Miniflare } = await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
const { unstable_splitSqlQuery } = await import(`${root}/vnext/node_modules/.bun/wrangler@4.97.0+01d2f64f02d20ae6/node_modules/wrangler/wrangler-dist/cli.js`)
let outboundCalls = 0
const mf = new Miniflare({ modules: true, modulesRoot: scratch, scriptPath: bundle, compatibilityDate: '2025-06-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'd10b-static' }, d1Persist: join(scratch, 'd1'), kvNamespaces: ['KV', 'IMAGE_CACHE'], images: { binding: 'IMAGES' }, r2Buckets: ['FILES'], outboundService: async () => { outboundCalls++; throw new Error('Fixture egress blocked') } })
const results = []
try {
  const db = await mf.getD1Database('DB')
  for (const file of (await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(name => name.endsWith('.sql')).sort()) {
    for (const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${file}`, 'utf8'))) await db.prepare(sql).run()
  }
  const origin = (await mf.ready).origin
  for (const [asset, type] of [['runner.mjs', 'text/javascript'], ['runner.sha256', 'text/plain'], ['setup.sh', 'text/x-shellscript'], ['setup.ps1', 'text/plain']]) {
    const response = await mf.dispatchFetch(origin + '/setup/' + asset)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), type + '; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.deepEqual(bytes, await readFile(`${root}/vnext/packages/gateway/src/control-plane/setup/dist/${asset}.txt`))
    if (asset.startsWith('setup.')) assert(!bytes.toString().includes('__RUNNER_SHA256__'))
    results.push({ asset, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  for (const asset of ['missing', 'constructor', 'toString', '__proto__', 'runner.mjs?unexpected=true']) assert.equal((await mf.dispatchFetch(origin + '/setup/' + asset)).status, 404, asset)
  assert.equal(outboundCalls, 0)
} finally { await mf.dispose() }
await writeFile(join(scratch, 'results.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify({ scratch, results, outboundCalls, passed: true }))
