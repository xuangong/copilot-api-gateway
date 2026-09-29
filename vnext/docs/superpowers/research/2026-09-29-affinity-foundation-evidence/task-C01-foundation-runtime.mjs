import { readdir, readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const root=process.env.VNEXT_PROBE_ROOT;assert(root,'VNEXT_PROBE_ROOT required')
const { Miniflare }=await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
const { unstable_splitSqlQuery }=await import(`${root}/vnext/node_modules/.bun/wrangler@4.97.0+01d2f64f02d20ae6/node_modules/wrangler/wrangler-dist/cli.js`)
const scratch=await mkdtemp(`${tmpdir()}/c01-foundation-runtime-`),entry=`${scratch}/worker.ts`,bundle=`${scratch}/worker.mjs`
await writeFile(entry,(await readFile(new URL('./task-C01-foundation-worker.ts.txt',import.meta.url),'utf8')).replaceAll('__ROOT__',root).replaceAll('__CASES__',new URL('./task-C01-foundation-codec-cases.mjs',import.meta.url).pathname).replaceAll('__ANALYSIS_CASES__',new URL('./task-C01-foundation-analysis-cases.mjs',import.meta.url).pathname))
const build=spawnSync('bun',['build',entry,'--target=node',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'});assert.equal(build.status,0,build.stderr)
const carrier=await import(`${root}/vnext/packages/gateway/src/shared/affinity/carrier.ts`)
const {runCodecCases}=await import('./task-C01-foundation-codec-cases.mjs')
const {runAnalysisCases}=await import('./task-C01-foundation-analysis-cases.mjs')
const analysis=await import(`${root}/vnext/packages/gateway/src/shared/affinity/analysis.ts`)
const bun={codec:await runCodecCases(carrier),analysis:await runAnalysisCases(carrier,analysis)}
let outbound=0
const mf=new Miniflare({modules:true,modulesRoot:scratch,scriptPath:bundle,compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'c01-foundation'},r2Buckets:{FILES:'c01-files'},outboundService:async()=>{outbound++;throw new Error('Unexpected outbound')}})
try{
 const db=await mf.getD1Database('DB')
 for(const name of(await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(n=>n.endsWith('.sql')).sort())for(const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${name}`,'utf8')))await db.prepare(sql).run()
 const now=new Date().toISOString()
 await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind('synthetic-owner','Synthetic','test@local.dev',now).run()
 await db.prepare('INSERT INTO user_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind('ses_synthetic','synthetic-owner',now,new Date(Date.now()+3600000).toISOString()).run()
 for(const id of ['synthetic-key','other-key'])await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)').bind(id,'Synthetic',`${id}-raw`,now,'synthetic-owner').run()
 const response=await mf.dispatchFetch('http://local/__fixture/affinity'),text=await response.text();assert.equal(response.status,200,text);const workerd=JSON.parse(text)
 const keysResponse=await mf.dispatchFetch('http://local/api/keys',{headers:{cookie:'session_token=ses_synthetic'}}),keysText=await keysResponse.text();assert.equal(keysResponse.status,200,keysText);assert(!keysText.includes('affinity_')&&!keysText.includes('secret'),'Private key leaked from API')
 assert.equal(outbound,0)
 console.log(JSON.stringify({passed:true,bun,workerd,actualSessionApiPrivate:true,outbound,scratch}))
}finally{await mf.dispose()}
