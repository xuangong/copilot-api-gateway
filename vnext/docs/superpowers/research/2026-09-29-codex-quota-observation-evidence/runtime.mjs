import { readdir, readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const root=process.env.VNEXT_PROBE_ROOT;assert(root,'VNEXT_PROBE_ROOT required')
const { Miniflare }=await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
const { unstable_splitSqlQuery }=await import(`${root}/vnext/node_modules/.bun/wrangler@4.97.0+01d2f64f02d20ae6/node_modules/wrangler/wrangler-dist/cli.js`)
const scratch=await mkdtemp(`${tmpdir()}/c09-quota-runtime-`),entry=`${scratch}/worker.ts`,bundle=`${scratch}/worker.mjs`
await writeFile(entry,(await readFile(new URL('./task-C09-worker.ts.txt',import.meta.url),'utf8')).replaceAll('__ROOT__',root))
const build=spawnSync('bun',['build',entry,'--target=node',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'});assert.equal(build.status,0,build.stderr)
let outbound=0
const mf=new Miniflare({modules:true,modulesRoot:scratch,scriptPath:bundle,compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'c09-quota'},r2Buckets:{FILES:'c09-files'},outboundService:async()=>{outbound++;throw new Error('Quota read used outbound transport')}})
try {
 const db=await mf.getD1Database('DB')
 for(const name of(await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(n=>n.endsWith('.sql')).sort())for(const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${name}`,'utf8')))await db.prepare(sql).run()
 const nowMs=Date.now(),now=new Date(nowMs).toISOString(),expires=new Date(nowMs+3600000).toISOString(),day=86400000
 for(const owner of ['owner','foreign','admin']){
  await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind(owner,owner,owner==='admin'?'test@local.dev':`${owner}@example.invalid`,now).run()
  await db.prepare('INSERT INTO user_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind(`ses_${owner}`,owner,now,expires).run()
 }
 await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)').bind('key','fixture','raw-fixture',now,'owner').run()
 await db.prepare('INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind('prewarm','owner','copilot','Synthetic prewarm',JSON.stringify({githubToken:'synthetic-github',accountType:'individual'}),'[{"id":"direct_fetch"}]',now,now).run()
 const headers=auth=>auth==='apikey'?{authorization:'Bearer raw-fixture'}:auth?{cookie:`session_token=ses_${auth}`} : {}
 const read=async(id='quota',auth='owner')=>{
  const response=await mf.dispatchFetch(`http://local/api/upstreams/${id}/codex/quota`,{headers:headers(auth)})
  const text=await response.text();let data;try{data=JSON.parse(text)}catch{data=text}
  assert(!/synthetic-(?:access|refresh|github|account|device)/.test(text),'Private credential or account leak')
  return {status:response.status,data,text}
 }
 const account={chatgptAccountId:'synthetic-account',refresh_token:'synthetic-refresh',state:'active',state_updated_at:now,openaiDeviceId:'synthetic-device',accessToken:{token:'synthetic-access',expiresAt:nowMs-1000,refreshedAt:now},quotaSnapshot:null}
 const config={accounts:[{chatgptAccountId:'synthetic-account',email:null,chatgptUserId:null,planType:null}]}
 const insert=async(id,state)=>db.prepare('INSERT INTO upstreams(id,owner_id,provider,name,config_json,state_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,'owner','codex','Synthetic quota',JSON.stringify(config),JSON.stringify(state),'[{"id":"direct_fetch"}]',now,now).run()
 await insert('quota',{accounts:[account]})
 const set=async quotaSnapshot=>db.prepare('UPDATE upstreams SET state_json=? WHERE id=?').bind(JSON.stringify({accounts:[{...account,quotaSnapshot}]}),'quota').run()
 const state=()=>db.prepare('SELECT * FROM upstreams WHERE id=?').bind('quota').first()
 assert.equal((await read('quota','')).status,403)
 assert.equal((await read('quota','apikey')).status,403)
 const foreign=await read('quota','foreign'),missing=await read('missing','foreign');assert.equal(foreign.status,404);assert.deepEqual(foreign,missing)
 const empty=await read();assert.equal(empty.status,200,empty.text);assert.equal(empty.data.quota,null)
 assert.equal((await read('quota','admin')).status,200)
 const fetchedAt=nowMs-3*day,observedAt=new Date(fetchedAt-2000).toISOString()
 await set({stale:{fetchedAt,data:{observed_at:observedAt,primary_used_percent:0,secondary_used_percent:100}},fresh:{fetchedAt:nowMs,data:{observed_at:now,primary_used_percent:42,primary_reset_after_at:new Date(nowMs+2*day).toISOString(),injected:'synthetic-refresh'}},invalid:{fetchedAt:nowMs,data:{observed_at:'invalid-date',primary_used_percent:1}},unknown:{fetchedAt:nowMs,data:{observed_at:now}},badFields:{fetchedAt:nowMs,data:{observed_at:now,primary_used_percent:'0',secondary_used_percent:-1,primary_reset_after_at:'not-a-date',credits_balance:'5'}}})
 const before=await state(),result=await read();assert.equal(result.status,200,result.text)
 assert.equal(result.data.quota.stale.freshness,'stale');assert.equal(result.data.quota.stale.observedAt,observedAt);assert.equal(result.data.quota.stale.fetchedAt,fetchedAt);assert.equal(result.data.quota.stale.freshUntil,fetchedAt+day);assert.equal(result.data.quota.stale.data.primary_used_percent,0)
 assert.equal(result.data.quota.fresh.freshness,'fresh');assert.equal(result.data.quota.fresh.freshUntil,nowMs+2*day);assert(!('injected' in result.data.quota.fresh.data));assert(!('invalid' in result.data.quota))
 assert(!('primary_used_percent' in result.data.quota.unknown.data));assert(!('primary_used_percent' in result.data.quota.badFields.data));assert(!('primary_reset_after_at' in result.data.quota.badFields.data))
 const repeated=await read();assert.deepEqual(repeated.data,result.data,'Fresh horizon moved on reread');assert.deepEqual(await state(),before,'Quota GET mutated upstream')
 await (await mf.dispatchFetch('http://local/__fixture/drain')).text();assert.equal(outbound,0,'Read triggered credential renewal or Copilot prewarm')
 console.log(JSON.stringify({runtime:'actual app/workerd/D1',passed:true,ownerAdminAuth:true,foreignMissingEquivalent:true,sessionOnly:true,lastObservedStale:true,unknownVersusZero:true,fixedFreshness:true,sanitizedDto:true,zeroWrites:true,outbound,scratch}))
} finally {await mf.dispose()}
