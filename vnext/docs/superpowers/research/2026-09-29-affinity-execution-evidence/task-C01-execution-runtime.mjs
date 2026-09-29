import assert from 'node:assert/strict'
import {serve} from 'bun'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const source=`${root}/vnext`
const {bootstrapBunPlatform}=await import(`${source}/apps/platform-bun/src/bootstrap.ts`)
const {initBackground,initSocketDial}=await import(`${source}/packages/platform/src/index.ts`)
const {getRepo}=await import(`${source}/packages/gateway/src/repo/index.ts`)
const {CodexProvider}=await import(`${source}/packages/provider-codex/src/provider.ts`)
const {affinityTargetMatch}=await import(`${source}/packages/provider-llm/src/opaque-affinity.ts`)
const scratch=await mkdtemp(`${tmpdir()}/c01-execution-runtime-`)
const {db}=bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
const pending=[];initBackground({waitUntil:p=>pending.push(p)})
initSocketDial(async()=>{throw new Error('External socket blocked')})
const calls=[];let replaceOn401,replaceOnOAuth
const server=serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 const body=await req.text(),path=new URL(req.url).pathname;calls.push({path,body,headers:Object.fromEntries(req.headers)})
 if(path.endsWith('/token')&&replaceOnOAuth){const replace=replaceOnOAuth;replaceOnOAuth=undefined;await replace();return Response.json({error:'invalid_grant'},{status:400})}
 if(replaceOn401){const replace=replaceOn401;replaceOn401=undefined;await replace();return Response.json({error:{code:'unauthorized'}},{status:401})}
 assert(!path.endsWith('/token'),'Unexpected OAuth request')
 return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"fixture","status":"completed","output":[]}}\n\n',{headers:{'content-type':'text/event-stream'}})
}})
const fetcher=async(input,init)=>{
 const request=input instanceof Request?input:new Request(input,init),url=new URL(request.url)
 assert(['chatgpt.com','auth.openai.com'].includes(url.hostname),'Unexpected external host')
 return fetch(`http://127.0.0.1:${server.port}${url.pathname}`,{method:request.method,headers:request.headers,body:request.method==='GET'?undefined:await request.text(),signal:request.signal})
}
let sequence=0
const fixture=async(lite=false)=>{
 const id=`fixture-${++sequence}`,now=new Date().toISOString()
 await getRepo().upstreams.save({id,ownerId:'owner',provider:'codex',name:id,enabled:true,sortOrder:0,config:{accounts:[{chatgptAccountId:'account',email:null,chatgptUserId:null,planType:null}]},state:{accounts:[{chatgptAccountId:'account',credentialRevision:'revision',refresh_token:'synthetic-refresh',state:'active',state_updated_at:now,openaiDeviceId:'device',accessToken:{token:'synthetic-token',expiresAt:Date.now()+3600000,refreshedAt:now},quotaSnapshot:null}]},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[],createdAt:now,updatedAt:now})
 const row=await getRepo().upstreams.getById(id);assert(row)
 const provider=new CodexProvider(row,fetcher)
 provider.setModelCatalog({object:'list',data:[{id:'raw-model',display_name:'Fixture',owned_by:'openai',kind:'chat',providerData:{useResponsesLite:lite},limits:{max_context_window_tokens:1000},endpoints:{responses:{}}}]})
 return {id,provider,row,request:{endpoint:'responses',payload:{model:'raw-model',input:[],stream:true},headers:new Headers(),sourceApi:'openai'}}
}
const fence=expected=>async actual=>{assert.equal(affinityTargetMatch(expected,actual),'exact','Execution identity changed')}
const passed=[]
try{
 for(const lite of [false,true]){
  const {provider,request}=await fixture(lite),before=calls.length,target=await provider.prepareAffinityExecution(request)
  assert(target);assert.equal(calls.length,before)
  const response=await provider.fetch({...request,beforeInference:fence(target)});await new Response(response.body).text()
  assert.deepEqual(response.affinityExecution,target);assert.equal(response.execution.modelKey,'raw-model');assert.equal(calls.length,before+1)
  assert.equal(JSON.parse(calls.at(-1).body).model,'raw-model');assert.equal(calls.at(-1).headers['x-openai-internal-codex-responses-lite'],lite?'true':undefined)
  passed.push(lite?'lite-exact':'normal-exact')
 }
 for(const change of ['config','revision','incarnation','expired-config','expired-revision']){
  const {id,provider,row,request}=await fixture(),target=await provider.prepareAffinityExecution(request);assert(target)
  if(change.includes('config'))await db.prepare("UPDATE upstreams SET config_json=json_set(config_json,'$.changed',1) WHERE id=?").bind(id).run()
  if(change.includes('revision'))await db.prepare("UPDATE upstreams SET state_json=json_set(state_json,'$.accounts[0].credentialRevision','replacement') WHERE id=?").bind(id).run()
  if(change==='incarnation'){await getRepo().upstreams.delete(id);await getRepo().upstreams.save(row)}
  if(change.startsWith('expired'))await db.prepare("UPDATE upstreams SET state_json=json_set(state_json,'$.accounts[0].accessToken.expiresAt',0) WHERE id=?").bind(id).run()
  const before=calls.length;await assert.rejects(()=>provider.fetch({...request,beforeInference:fence(target)}));assert.equal(calls.length,before,`${change} reached OAuth/inference`);passed.push(`${change}-zero-network`)
 }
 {
  const {id,provider,request}=await fixture(),target=await provider.prepareAffinityExecution(request);assert(target)
  replaceOn401=async()=>{await db.prepare("UPDATE upstreams SET state_json=json_set(state_json,'$.accounts[0].credentialRevision','replacement','$.accounts[0].accessToken.token','replacement-token') WHERE id=?").bind(id).run()}
  const before=calls.length;await assert.rejects(()=>provider.fetch({...request,beforeInference:fence(target)}));assert.equal(calls.length,before+1);passed.push('401-replacement-no-retry')
 }
 {
  const {id,provider,request}=await fixture(),target=await provider.prepareAffinityExecution(request);assert(target)
  await db.prepare("UPDATE upstreams SET state_json=json_set(state_json,'$.accounts[0].accessToken.expiresAt',0) WHERE id=?").bind(id).run()
  replaceOnOAuth=async()=>{await db.prepare("UPDATE upstreams SET state_json=json_set(state_json,'$.accounts[0].credentialRevision','replacement','$.accounts[0].refresh_token','replacement-refresh','$.accounts[0].accessToken',null) WHERE id=?").bind(id).run()}
  const before=calls.length;await assert.rejects(()=>provider.fetch({...request,beforeInference:fence(target)}));assert.equal(calls.length,before+1,'Internal OAuth recovery used replacement identity before fence');assert(calls.at(-1).path.endsWith('/token'));passed.push('oauth-pending-replacement-no-recursive-mint')
 }
 await Promise.all(pending)
 console.log(JSON.stringify({passed:true,runtime:'actual Bun CodexProvider + loopback HTTP + real SQLite',cases:passed,networkCalls:calls.length,oauth:calls.filter(c=>c.path.endsWith('/token')).length,scratch}))
}finally{server.stop(true)}
