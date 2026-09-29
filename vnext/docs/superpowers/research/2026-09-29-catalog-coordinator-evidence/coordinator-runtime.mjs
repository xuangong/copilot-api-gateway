import { readdir,readFile,writeFile,mkdtemp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const root=process.env.VNEXT_PROBE_ROOT;assert(root,'VNEXT_PROBE_ROOT required')
const { Miniflare } = await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
const { unstable_splitSqlQuery } = await import(`${root}/vnext/node_modules/.bun/wrangler@4.97.0+01d2f64f02d20ae6/node_modules/wrangler/wrangler-dist/cli.js`)
const scratch=await mkdtemp(`${tmpdir()}/c02-coordinator-d1-`),entry=`${scratch}/worker.mjs`,bundle=`${scratch}/bundle.mjs`
await writeFile(entry,(await readFile(new URL('./coordinator-worker.mjs',import.meta.url),'utf8')).replaceAll('__ROOT__',root))
const build=spawnSync('bun',['build',entry,'--target=node',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'});assert.equal(build.status,0,build.stderr)
const mf=new Miniflare({modules:true,modulesRoot:scratch,scriptPath:bundle,compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'c02-coordinator'},bindings:{MEASURE_DEFAULT_BUDGET:process.env.MEASURE_DEFAULT_BUDGET==='1'}})
try{
 const db=await mf.getD1Database('DB');const migrations=[]
 for(const file of(await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(p=>p.endsWith('.sql')).sort()){
  for(const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${file}`,'utf8')))await db.prepare(sql).run()
  migrations.push(file)
 }
 const response=await mf.dispatchFetch('http://local/');const body=await response.text();assert.equal(response.status,200,body)
 const result=JSON.parse(body);assert.equal(result.passed,true)
 console.log(JSON.stringify({runtime:'actual local workerd+D1Repo catalog coordinator acceptance',migrations,...result,scratch}))
}finally{await mf.dispose()}
