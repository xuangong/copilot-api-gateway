import { readdir, readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const root=process.env.VNEXT_PROBE_ROOT;assert(root,'VNEXT_PROBE_ROOT required')
const { Miniflare }=await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
const { unstable_splitSqlQuery }=await import(`${root}/vnext/node_modules/.bun/wrangler@4.97.0+01d2f64f02d20ae6/node_modules/wrangler/wrangler-dist/cli.js`)
const scratch=await mkdtemp(`${tmpdir()}/c08-import-runtime-`),entry=`${scratch}/worker.ts`,bundle=`${scratch}/worker.mjs`
await writeFile(entry,(await readFile(new URL('./task-C08-import-worker.ts.txt',import.meta.url),'utf8')).replaceAll('__ROOT__',root))
const build=spawnSync('bun',['build',entry,'--target=node',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'});assert.equal(build.status,0,build.stderr)
let outbound=0,allowRefresh=false,delayRefresh=false,releaseDelayed=()=>{},enteredDelayed=()=>{}
const delayGate=new Promise(resolve=>{releaseDelayed=resolve}),delayEntered=new Promise(resolve=>{enteredDelayed=resolve})
const mf=new Miniflare({modules:true,modulesRoot:scratch,scriptPath:bundle,compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'c08-import'},r2Buckets:{FILES:'c08-files'},outboundService:async request=>{
 outbound++
 assert(allowRefresh,'Preview/import unexpectedly used outbound transport')
 assert(new URL(request.url).pathname.endsWith('/oauth/token'),'Unexpected credential-management outbound endpoint')
 if(delayRefresh){enteredDelayed();await delayGate}
 return Response.json({access_token:'synthetic-minted',refresh_token:'synthetic-rotated',id_token:'synthetic-id-token',expires_in:3600,token_type:'Bearer'})
}})
try{
 const db=await mf.getD1Database('DB')
 for(const name of(await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(n=>n.endsWith('.sql')).sort())for(const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${name}`,'utf8')))await db.prepare(sql).run()
 const now=new Date().toISOString(),expires=new Date(Date.now()+3600000).toISOString()
 for(const owner of ['owner','foreign','admin']){
  await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind(owner,owner,owner==='admin'?'test@local.dev':`${owner}@example.invalid`,now).run()
  await db.prepare('INSERT INTO user_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind(`ses_${owner}`,owner,now,expires).run()
 }
 await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)').bind('key','fixture','raw-fixture',now,'owner').run()
 await db.prepare('INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind('prewarm','owner','copilot','Synthetic prewarm',JSON.stringify({githubToken:'synthetic-github',accountType:'individual'}),'[{"id":"direct_fetch"}]',now,now).run()
 const request=async(path,body,auth='owner')=>{
  const headers={'content-type':'application/json',...(auth==='apikey'?{authorization:'Bearer raw-fixture'}:auth?{cookie:`session_token=ses_${auth}`}:{})}
  const response=await mf.dispatchFetch(`http://local${path}`,{method:'POST',headers,body:body===undefined?undefined:JSON.stringify(body)})
  const text=await response.text();let data;try{data=JSON.parse(text)}catch{data=text}return{status:response.status,data,text}
 }
 const safe=result=>{assert(!/synthetic-(?:access|replacement|refresh|rotated|minted|github)/.test(result.text),'Public credential leak');assert(!result.data.upstream || !('state' in result.data.upstream),'Private state exposed')}
 const document=JSON.stringify({accounts:[{platform:'anthropic',type:'oauth',credentials:{}},{name:'Invalid',credentials:{access_token:'synthetic-access'}},{name:'Selected',credentials:{access_token:'synthetic-access',account_id:'synthetic-account'}}]})
 const before=(await db.prepare('SELECT COUNT(*) AS count FROM upstreams').first()).count
 for(const auth of ['', 'apikey'])assert.equal((await request('/api/upstreams/codex/preview',{document},auth)).status,403)
 const preview=await request('/api/upstreams/codex/preview',{document});assert.equal(preview.status,200,preview.text);safe(preview)
 assert.deepEqual(preview.data.candidates.map(c=>c.sourceIndex),[1,2]);assert.equal(preview.data.candidates[0].importable,false);assert.equal(preview.data.candidates[1].importable,true)
 assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM upstreams').first()).count,before);assert.equal(outbound,0)
 const large=await request('/api/upstreams/codex/preview',{document:' '.repeat(1024*1024)});assert.equal(large.status,413,large.text)
 const streamCap=await (await mf.dispatchFetch('http://local/__fixture/stream-cap')).json();assert.equal(streamCap.status,413);assert(streamCap.canceled && streamCap.sent<20,JSON.stringify(streamCap))
 const rows=await request('/api/upstreams/codex/preview',{document:JSON.stringify({accounts:Array.from({length:101},()=>({platform:'anthropic'}))})});assert.equal(rows.status,400,rows.text)
 const imported=await request('/api/upstreams/codex/import',{document,sourceIndex:2,name:'Synthetic Codex',enabled:false,sortOrder:7,disabledPublicModelIds:['synthetic-disabled'],proxyFallbackList:[{id:'direct_fetch'}]});assert.equal(imported.status,201,imported.text);safe(imported)
 const id=imported.data.upstream.id;assert.equal(imported.data.upstream.credentialStatus.renewable,false)
 const read=()=>db.prepare('SELECT * FROM upstreams WHERE id=?').bind(id).first()
 const initial=await read();const initialAccount=JSON.parse(initial.state_json).accounts[0]
 assert.equal(initialAccount.accessToken.token,'synthetic-access');assert.equal(initial.owner_id,'owner')
 const nonrenewable=await request(`/api/upstreams/${id}/credentials/refresh`);assert(nonrenewable.status>=400&&nonrenewable.status<500,nonrenewable.text);safe(nonrenewable);assert.equal((await read()).state_json,initial.state_json)
 const replacement=JSON.stringify({tokens:{access_token:'synthetic-replacement',refresh_token:'synthetic-refresh',account_id:'synthetic-account'}})
 const reimport=await request('/api/upstreams/codex/import',{document:replacement,sourceIndex:0,upstreamId:id});assert.equal(reimport.status,200,reimport.text);safe(reimport)
 const after=await read(),afterAccount=JSON.parse(after.state_json).accounts[0]
 for(const field of ['id','owner_id','name','enabled','sort_order','created_at','proxy_fallback_list_json','disabled_public_model_ids_json'])assert.equal(after[field],initial[field],field)
 assert.equal(afterAccount.openaiDeviceId,initialAccount.openaiDeviceId);assert.notEqual(afterAccount.credentialRevision,initialAccount.credentialRevision);assert.equal(after.catalog_generation,initial.catalog_generation+1)
 const wrongAccount=await request('/api/upstreams/codex/import',{document:JSON.stringify({tokens:{access_token:'synthetic-access',account_id:'different-account'}}),sourceIndex:0,upstreamId:id});assert.equal(wrongAccount.status,409,wrongAccount.text);safe(wrongAccount)
 const foreign=await request('/api/upstreams/codex/import',{document:replacement,sourceIndex:0,upstreamId:id},'foreign'),missing=await request('/api/upstreams/codex/import',{document:replacement,sourceIndex:0,upstreamId:'missing'},'foreign');assert.equal(foreign.status,404);assert.deepEqual(foreign,missing)
 assert.equal(outbound,0)
 allowRefresh=true
 const refreshed=await request(`/api/upstreams/${id}/credentials/refresh`);assert.equal(refreshed.status,200,refreshed.text);safe(refreshed)
 assert.equal(outbound,1);const final=await read();assert.equal(JSON.parse(final.state_json).accounts[0].accessToken.token,'synthetic-minted');assert.equal(final.catalog_generation,after.catalog_generation)
 delayRefresh=true
 const cancelPending=mf.dispatchFetch(`http://local/__fixture/cancel-refresh?id=${encodeURIComponent(id)}`)
 let arrivalTimeout
 await Promise.race([delayEntered,new Promise((_,reject)=>{arrivalTimeout=setTimeout(()=>reject(new Error('Canceled refresh did not enter transport')),2000)})]);clearTimeout(arrivalTimeout)
 const canceled=await (await cancelPending).json();assert(canceled.aborted && canceled.status===499 && canceled.elapsedMs<1000,JSON.stringify(canceled))
 releaseDelayed();await new Promise(resolve=>setTimeout(resolve,100));delayRefresh=false
 assert.equal((await read()).state_json,final.state_json,'Canceled refresh published a late credential')
 assert.equal(outbound,2)
 await db.prepare('UPDATE upstreams SET proxy_fallback_list_json=? WHERE id=?').bind('[{"id":"synthetic-missing-proxy"}]',id).run()
 const blocked=await request(`/api/upstreams/${id}/credentials/refresh`);assert.equal(blocked.status,502,blocked.text);safe(blocked)
 assert.equal(outbound,2,'Configured route failure fell back to outbound transport');assert.equal((await read()).state_json,final.state_json)
 console.log(JSON.stringify({runtime:'actual local workerd app + D1 + synthetic outbound service',passed:true,sessionOnly:true,previewPure:true,stableSelection:true,bodyAndRowCaps:true,streamCap,oneRowImport:true,reimportPreservationAndGeneration:true,accountConflict:true,foreignMissing404:true,accessOnlyRefreshNoMutation:true,renewableRefresh:true,configuredEgressFailureNoFallback:true,explicitRefreshCancellation:canceled,outbound,scratch}))
}finally{releaseDelayed();await mf.dispose()}
