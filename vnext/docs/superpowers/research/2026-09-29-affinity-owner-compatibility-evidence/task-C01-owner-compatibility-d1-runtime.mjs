import {readdir,readFile,writeFile,mkdtemp} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const {Miniflare}=await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
const {unstable_splitSqlQuery}=await import(`${root}/vnext/node_modules/.bun/wrangler@4.97.0+01d2f64f02d20ae6/node_modules/wrangler/wrangler-dist/cli.js`)
const scratch=await mkdtemp(`${tmpdir()}/c01-owner-d1-`),entry=`${scratch}/worker.ts`,bundle=`${scratch}/worker.mjs`
await writeFile(entry,(await readFile(new URL('./task-C01-integration-worker.ts.txt',import.meta.url),'utf8')).replaceAll('__ROOT__',root))
const build=spawnSync('bun',['build',entry,'--target=node',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'});assert.equal(build.status,0,build.stderr)
const calls=[];let serial=0
const mf=new Miniflare({modules:true,modulesRoot:scratch,scriptPath:bundle,compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'c01-affinity'},r2Buckets:{FILES:'c01-files'},outboundService:async req=>{
 assert.equal(new URL(req.url).hostname,'synthetic.invalid','Unexpected outbound host')
 const body=await req.json();calls.push(body)
 const output=[{id:`cmp_${++serial}`,type:'compaction',encrypted_content:'synthetic-opaque'}]
 return Response.json({id:`resp_${serial}`,object:'response',status:'completed',model:body.model,output,error:null,incomplete_details:null,usage:{input_tokens:5,output_tokens:3,total_tokens:8}})
}})
try{
 const db=await mf.getD1Database('DB')
 for(const file of(await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(f=>f.endsWith('.sql')).sort())for(const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${file}`,'utf8')))await db.prepare(sql).run()
 const now=new Date().toISOString()
 await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind('owner','Synthetic','synthetic@example.invalid',now).run()
 for(const key of ['key','other'])await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)').bind(key,key,`raw-${key}`,now,'owner',86400).run()
 for(const id of ['up_a','up_b'])await db.prepare('INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,'owner','custom',id,JSON.stringify({name:id,baseUrl:`https://synthetic.invalid/${id}`,authStyle:'none',endpoints:['responses'],models:['synthetic-model'],opaqueCompatibility:{'synthetic-model':{version:1,key:'synthetic-group',scope:'owner'}}}),'[{"id":"direct_fetch"}]',now,now).run()
 const request=async(extra={},key='key')=>{
  const r=await mf.dispatchFetch('http://local/v1/responses',{method:'POST',headers:{authorization:`Bearer raw-${key}`,'content-type':'application/json'},body:JSON.stringify({model:'up_a/synthetic-model',input:[{role:'user',content:'synthetic'}],stream:false,...extra})});const text=await r.text();return{status:r.status,json:JSON.parse(text),text}
 }
 const first=await request();assert.equal(first.status,200,first.text)
 const item=first.json.output[0]
 if(process.env.C01_BASELINE==='1'){console.log(JSON.stringify({baseline:true,runtime:'actual app/workerd/D1',status:first.status,carrierActivated:item.encrypted_content.startsWith('vnext-affinity:'),calls:calls.length}))}
 else{
  assert(item.encrypted_content.startsWith('vnext-affinity:'))
  let before=calls.length;const wrongKey=await request({input:[item]},'other');assert(wrongKey.status>=400,wrongKey.text);assert.equal(calls.length,before)
  before=calls.length;const wrongPin=await request({model:'up_b/synthetic-model',input:[item]});assert.equal(wrongPin.status,200,wrongPin.text);assert.equal(calls.length,before+1);assert.equal(calls.at(-1).input[0].encrypted_content,'synthetic-opaque')
  const continuation=await request({previous_response_id:first.json.id,input:[{role:'user',content:'next'}]});assert.equal(continuation.status,200,continuation.text);assert(calls.at(-1).input.some(i=>i.type==='compaction'&&i.encrypted_content==='synthetic-opaque'))
  await db.prepare("UPDATE upstreams SET config_json=json_set(config_json,'$.changed',true) WHERE id='up_a'").run()
  before=calls.length;const replacement=await request({input:[item]});assert(replacement.status>=400,replacement.text);assert.equal(calls.length,before)
  const privateKey=await db.prepare('SELECT affinity_secret,affinity_key_id FROM api_keys WHERE id=?').bind('key').first();assert(privateKey?.affinity_secret&&privateKey?.affinity_key_id)
  console.log(JSON.stringify({passed:true,runtime:'actual app/workerd/WebCrypto/D1 durable store',cases:['authenticated-egress','wrong-key-zero-egress','declared-required-cross-upstream-replay','immediate-durable-continuation','stale-config-zero-egress'],calls:calls.length,scratch}))
 }
 await(await mf.dispatchFetch('http://local/__fixture/drain')).text()
}finally{await mf.dispose()}
