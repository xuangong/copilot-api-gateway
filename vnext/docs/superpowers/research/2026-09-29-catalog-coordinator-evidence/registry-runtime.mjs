import { readdir, readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const root=process.env.VNEXT_PROBE_ROOT;assert(root,'VNEXT_PROBE_ROOT required')
const { Miniflare }=await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
const { unstable_splitSqlQuery }=await import(`${root}/vnext/node_modules/.bun/wrangler@4.97.0+01d2f64f02d20ae6/node_modules/wrangler/wrangler-dist/cli.js`)
const coordination=process.env.EXPECT_COORDINATION!=='0'
const scratch=await mkdtemp(`${tmpdir()}/c02-registry-runtime-`),entry=`${scratch}/worker.ts`,bundle=`${scratch}/worker.mjs`
await writeFile(entry,(await readFile(new URL('./registry-worker.ts.txt',import.meta.url),'utf8')).replaceAll('__ROOT__',root))
const build=spawnSync('bun',['build',entry,'--target=node',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'});assert.equal(build.status,0,build.stderr)
let release,entered,discovery=0,execution=0,failDiscovery=false,cancelDiscovery=0,cancelClosed=false
const gate=new Promise(resolve=>{release=resolve}),received=new Promise(resolve=>{entered=resolve})
const origin=createServer(async(req,res)=>{
 if(req.url.startsWith('/cancel/')){cancelDiscovery++;res.on('close',()=>{cancelClosed=true});return}
 if(req.url.endsWith('/models')){
  discovery++;entered();await gate
  if(failDiscovery){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'synthetic discovery failure'}}));return}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'fixture-model',object:'model'}]}));return
 }
 let body='';for await(const chunk of req)body+=chunk
 execution++;assert(JSON.parse(body).model==='fixture-model')
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'resp_fixture',object:'response',model:'fixture-model',status:'completed',output:[{id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'reply-synthetic',annotations:[]}]}],usage:{input_tokens:3,output_tokens:2,total_tokens:5}}))
})
await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));const address=origin.address();assert(address&&typeof address!=='string')
const options={modules:true,modulesRoot:scratch,scriptPath:bundle,compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'c02-shared-registry'},r2Buckets:{FILES:'c02-shared-files'}}
const mf=new Miniflare({workers:[{...options,name:'first'},{...options,name:'second'}]})
try{
 const db=await mf.getD1Database('DB','first')
 for(const name of(await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(n=>n.endsWith('.sql')).sort())for(const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${name}`,'utf8')))await db.prepare(sql).run()
 const now=new Date().toISOString(),expires=new Date(Date.now()+3600000).toISOString()
 for(const owner of ['owner','foreign','cancel']){
  await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind(owner,owner,`${owner}@example.invalid`,now).run()
  await db.prepare('INSERT INTO user_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind(`ses_${owner}`,owner,now,expires).run()
 }
 await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)').bind('key','fixture','raw-fixture',now,'owner').run()
 const config={name:'fixture',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'synthetic-key',endpoints:['responses']}
 await db.prepare('INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind('up','owner','custom','fixture',JSON.stringify(config),'[{"id":"direct_fetch"}]',now,now).run()
 await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)').bind('key-cancel','fixture','raw-cancel',now,'cancel').run()
 await db.prepare('INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind('up-cancel','cancel','custom','fixture',JSON.stringify({...config,baseUrl:`http://127.0.0.1:${address.port}/cancel/v1`}),'[{"id":"direct_fetch"}]',now,now).run()
 const first=await mf.getWorker('first'),second=await mf.getWorker('second')
 const headers={authorization:'Bearer raw-fixture'},cookie={cookie:'session_token=ses_owner'}
 const cachedEmpty=await first.fetch('http://local/api/upstreams/up/models',{headers:cookie});assert.equal(cachedEmpty.status,200);assert.equal((await cachedEmpty.json()).cached,false);assert.equal(discovery,0)
 assert.equal((await first.fetch('http://local/api/upstreams/up/models',{headers:{cookie:'session_token=ses_foreign'}})).status,404)
 const a=first.fetch('http://local/v1/models',{headers}),b=second.fetch('http://local/v1/models',{headers})
 await received;await new Promise(resolve=>setTimeout(resolve,150));const beforeRelease=discovery;release()
 for(const response of await Promise.all([a,b])){const text=await response.text();assert.equal(response.status,200,text);assert(text.includes('fixture-model'),text)}
 assert.equal(beforeRelease,coordination?1:2,`Unexpected concurrent discovery count (${coordination?'coordinated':'baseline'})`)
 assert.equal(discovery,coordination?1:2)
 for(const worker of [first,second]){
  const response=await worker.fetch('http://local/v1/responses',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'synthetic',stream:false})})
  const text=await response.text();assert.equal(response.status,200,text);assert(text.includes('reply-synthetic'))
 }
 assert.equal(execution,2);assert.equal(discovery,coordination?1:2,'Dispatch rediscovered or used expired discovery signal')
 if(coordination){
  const catalog=await db.prepare("SELECT publication_version,models_json FROM model_catalogs WHERE upstream_id='up' AND catalog_revision=5").first();assert(catalog&&catalog.publication_version===1)
  const cached=await second.fetch('http://local/api/upstreams/up/models',{headers:cookie});assert.equal(cached.status,200);assert.equal((await cached.json()).cached,true);assert.equal(discovery,1)
  failDiscovery=true
  const failed=await first.fetch('http://local/api/upstreams/up/models?refresh=1',{headers:cookie});const body=await failed.text();assert.equal(failed.status,502,body)
  const after=await second.fetch('http://local/api/upstreams/up/models',{headers:cookie});assert.equal(after.status,200);const data=await after.json();assert.equal(data.cached,true);assert(data.models.some(m=>m.id==='fixture-model'))
  const retained=await db.prepare("SELECT publication_version FROM model_catalogs WHERE upstream_id='up' AND catalog_revision=5").first();assert.equal(retained.publication_version,1)
  const cancellation=await (await first.fetch('http://local/__fixture/cancel')).json();assert(cancellation.aborted&&cancellation.status>=400&&cancellation.elapsedMs<2000,JSON.stringify(cancellation))
  for(let i=0;i<100&&!cancelClosed;i++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(cancelDiscovery,1);assert(cancelClosed,'Origin connection remained open after actual transport abort')
  const canceledCatalog=await db.prepare("SELECT models_json FROM model_catalogs WHERE upstream_id='up-cancel' AND catalog_revision=5").first();assert.equal(canceledCatalog?.models_json,null)

 }
 console.log(JSON.stringify({runtime:'two actual local workerd isolates + shared D1 + loopback HTTP',coordination,beforeRelease,discovery,execution,cachedOpenNoDiscovery:true,foreignOwner404:true,dispatchAfterDiscoveryCleanup:true,explicitFailureRetainsCatalog:coordination,actualTransportCancellation:coordination?{cancelDiscovery,cancelClosed}:null,scratch,passed:true}))
}finally{release();await mf.dispose();origin.closeAllConnections();await new Promise(resolve=>origin.close(resolve))}
