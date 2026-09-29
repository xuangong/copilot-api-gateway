import assert from 'node:assert/strict'
import {serve} from 'bun'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const src=`${root}/vnext`
const {bootstrapBunPlatform}=await import(`${src}/apps/platform-bun/src/bootstrap.ts`)
const {initBackground,initSocketDial}=await import(`${src}/packages/platform/src/index.ts`)
const {getRepo}=await import(`${src}/packages/gateway/src/repo/index.ts`)
const {app}=await import(`${src}/packages/gateway/src/app.ts`)
const scratch=await mkdtemp(`${tmpdir()}/c01-owner-compat-`)
const {db}=bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
const pending=[];initBackground({waitUntil:p=>pending.push(p)})
initSocketDial(async()=>{throw new Error('External socket forbidden')})
const now=new Date().toISOString(),calls=[],cases=[]
for(const owner of ['owner','other','admin']){
 await getRepo().users.create({id:owner,name:owner,email:owner==='admin'?'test@local.dev':`${owner}@example.invalid`,createdAt:now,disabled:false})
 await getRepo().sessions.create({token:`ses_${owner}`,userId:owner,createdAt:now,expiresAt:'2099-01-01T00:00:00Z'})
}
for(const [id,owner] of [['key','owner'],['second','owner'],['foreign','other']])await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)').bind(id,id,`raw-${id}`,now,owner).run()
const upstream=serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 const body=await req.json(),path=new URL(req.url).pathname;calls.push({path,body})
 return Response.json({id:`resp_${calls.length}`,object:'response',status:'completed',model:body.model,output:[{type:'compaction',id:`cmp_${calls.length}`,encrypted_content:'synthetic-required-state'}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}})
}})
const server=serve({hostname:'127.0.0.1',port:0,fetch:req=>app.fetch(req,{})}),origin=`http://127.0.0.1:${server.port}`
async function control(path,body,who='owner',method=body?'POST':'GET'){
 const r=await fetch(origin+path,{method,headers:{'content-type':'application/json',origin,...(who?.startsWith('raw-')?{authorization:`Bearer ${who}`} : who?{cookie:`session_token=ses_${who}`}:{})},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();return{status:r.status,text,json:JSON.parse(text)}
}
const declaration={version:1,key:'synthetic-declared-group',scope:'owner'}
const config=name=>({name,baseUrl:`http://127.0.0.1:${upstream.port}/${name}`,authStyle:'none',endpoints:['responses'],models:['synthetic-model'],opaqueCompatibility:{'synthetic-model':declaration}})
async function create(name,who='owner',extra={}){return control('/api/upstreams',{provider:'custom',name,config:{...config(name),...extra},proxyFallbackList:[{id:'direct_fetch'}]},who)}
async function infer(id,input=[{role:'user',content:'synthetic'}],key='key'){
 const r=await fetch(`${origin}/v1/responses`,{method:'POST',headers:{authorization:`Bearer raw-${key}`,'content-type':'application/json'},body:JSON.stringify({model:`${id}/synthetic-model`,input,stream:false})});const text=await r.text();return{status:r.status,text,json:JSON.parse(text)}
}
try{
 const a=await create('compat_a'),b=await create('compat_b');assert.equal(a.status,201,a.text);assert.equal(b.status,201,b.text)
 if(process.env.C01_BASELINE==='1'){
  const first=await infer(a.json.upstream.id);assert.equal(first.status,200,first.text)
  const replay=await infer(b.json.upstream.id,first.json.output)
  const apiMutation=await create('baseline_api_mutation','raw-key');
  console.log(JSON.stringify({baseline:true,configRetained:!!a.json.upstream.config.opaqueCompatibility,replayStatus:replay.status,apiKeyMutationStatus:apiMutation.status,calls:calls.length}));
 }else{
  assert.deepEqual(a.json.upstream.config.opaqueCompatibility,{'synthetic-model':declaration});cases.push('owner-create-retains-declaration')
  const denied=await create('unauth',null);assert(denied.status>=400)
  const apiDenied=await create('api_only','raw-key');assert(apiDenied.status>=400);cases.push('session-only-configuration')
  const first=await infer(a.json.upstream.id);assert.equal(first.status,200,first.text);const item=first.json.output[0];assert(item.encrypted_content.startsWith('vnext-affinity:'))
  const replay=await infer(b.json.upstream.id,[item]);assert.equal(replay.status,200,replay.text);assert.equal(calls.at(-1).body.input[0].encrypted_content,'synthetic-required-state');cases.push('explicit-owner-required-state-replay')
  for(const key of ['second','foreign']){const n=calls.length,r=await infer(b.json.upstream.id,[item],key);assert(r.status>=400,r.text);assert.equal(calls.length,n)}cases.push('other-key-and-owner-zero-inference')
  const global=await control('/api/upstreams',{provider:'custom',name:'compat_global',ownerId:'',config:config('compat_global'),proxyFallbackList:[{id:'direct_fetch'}]},'admin');assert.equal(global.status,201,global.text)
  const globalReplay=await infer(global.json.upstream.id,[item]);assert.equal(globalReplay.status,200,globalReplay.text);assert.equal(calls.at(-1).body.input[0].encrypted_content,'synthetic-required-state')
  const privateOther=await create('compat_other','other');assert.equal(privateOther.status,201,privateOther.text)
  const privateCount=calls.length,privateReplay=await infer(privateOther.json.upstream.id,[item]);assert(privateReplay.status>=400,privateReplay.text);assert.equal(calls.length,privateCount);cases.push('authorized-global-compatible-private-other-owner-excluded')

  const foreignEdit=await control(`/api/upstreams/${a.json.upstream.id}`,{config:{opaqueCompatibility:{}}},'other','PATCH');assert.equal(foreignEdit.status,404)
  const edit=await control(`/api/upstreams/${a.json.upstream.id}`,{name:'renamed'},'owner','PATCH');assert.equal(edit.status,200,edit.text);assert.deepEqual(edit.json.upstream.config.opaqueCompatibility,{'synthetic-model':declaration});cases.push('unrelated-edit-retains-and-foreign-edit-denied')
  for(const bad of [{version:2,key:'group',scope:'owner'},{...declaration,unknown:true},{...declaration,key:''},{...declaration,scope:'everyone'}]){
   const r=await create(`bad_${cases.length}`, 'owner',{opaqueCompatibility:{'synthetic-model':bad}});assert.equal(r.status,400,r.text)
  }cases.push('strict-create-validation')
  const badPatch=await control(`/api/upstreams/${b.json.upstream.id}`,{config:{opaqueCompatibility:{'synthetic-model':{...declaration,key:' '}}}},'owner','PATCH');assert.equal(badPatch.status,400,badPatch.text)
  const exported=await control('/api/export?redact=1',null,'admin');assert.equal(exported.status,200,exported.text);assert.deepEqual(exported.json.upstreams.find(u=>u.id===b.json.upstream.id).config.opaqueCompatibility,{'synthetic-model':declaration})
  const imported=await control('/api/import',{mode:'merge',bundle:{version:2,exportedAt:now,apiKeys:[],githubAccounts:[],upstreams:[{...exported.json.upstreams.find(u=>u.id===b.json.upstream.id),id:'imported_compat',name:'imported_compat'}]}},'admin');assert.equal(imported.status,200,imported.text)
  const invalid=await control('/api/import',{mode:'merge',bundle:{version:2,exportedAt:now,apiKeys:[],githubAccounts:[],upstreams:[{...exported.json.upstreams.find(u=>u.id===b.json.upstream.id),id:'bad_import',config:{...config('bad_import'),opaqueCompatibility:{'synthetic-model':{...declaration,version:8}}}}]}},'admin');assert.equal(invalid.status,400,invalid.text);assert.equal(await getRepo().upstreams.getById('bad_import'),null);cases.push('export-import-and-validation')
  const remove=await control(`/api/upstreams/${b.json.upstream.id}`,{config:{opaqueCompatibility:{}}},'owner','PATCH');assert.equal(remove.status,200,remove.text)
  const n=calls.length,removedReplay=await infer(b.json.upstream.id,[item]);assert(removedReplay.status>=400,removedReplay.text);assert.equal(calls.length,n);cases.push('removal-invalidates-required-compatibility')
  await Promise.all(pending)
  console.log(JSON.stringify({passed:true,runtime:'actual authenticated Bun HTTP + loopback provider + real SQLite',cases,calls:calls.length,scratch}))
 }
}finally{server.stop(true);upstream.stop(true)}
