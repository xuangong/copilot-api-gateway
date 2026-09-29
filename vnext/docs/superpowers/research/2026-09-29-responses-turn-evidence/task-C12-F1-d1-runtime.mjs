import {readdir,readFile,writeFile,mkdtemp} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const {Miniflare}=await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
const {unstable_splitSqlQuery}=await import(`${root}/vnext/node_modules/.bun/wrangler@4.97.0+01d2f64f02d20ae6/node_modules/wrangler/wrangler-dist/cli.js`)
const scratch=await mkdtemp(`${tmpdir()}/c12-f1-d1-`),entry=`${scratch}/worker.ts`,bundle=`${scratch}/worker.mjs`
await writeFile(entry,(await readFile(new URL('./task-C01-integration-worker.ts.txt',import.meta.url),'utf8')).replaceAll('__ROOT__',root))
const build=spawnSync('bun',['build',entry,'--target=node',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'});assert.equal(build.status,0,build.stderr)
const calls=[];let serial=0
const mf=new Miniflare({modules:true,modulesRoot:scratch,scriptPath:bundle,compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'c12-f1'},r2Buckets:{FILES:'c12-files'},outboundService:async req=>{
 assert.equal(new URL(req.url).hostname,'synthetic.invalid');const body=await req.json();calls.push(body);serial++
 const mode=JSON.stringify(body.input??body.messages),chat=new URL(req.url).pathname.endsWith('/chat/completions')
 const result={id:`resp_${serial}`,object:'response',model:body.model,status:'completed',output:[],usage:{input_tokens:5,output_tokens:7,total_tokens:12}}
 let frames=chat?[
  {id:`chat_${serial}`,object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{role:'assistant',content:'Synthetic'},finish_reason:null}]},
  {id:`chat_${serial}`,object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}]},
  {id:`chat_${serial}`,object:'chat.completion.chunk',model:body.model,choices:[{index:0}],usage:{prompt_tokens:5,completion_tokens:17,total_tokens:22}}
 ]:[{type:'response.created',response:{...result,status:'in_progress',output:[]}},{type:'response.completed',response:result}]
 if(mode.includes('late-output'))frames.push({type:'response.output_text.delta',item_id:'late',output_index:1,content_index:0,delta:'MUST-NOT-LEAK'})
 if(mode.includes('late-error'))frames.push({type:'error',message:'synthetic-late-error'})
 if(mode.includes('tail-frames'))frames.push(...Array.from({length:300},()=>({type:'response.output_text.delta',item_id:'late',output_index:1,content_index:0,delta:'x'})))
 return new Response(frames.map(e=>`${e.type?`event: ${e.type}\n`:''}data: ${JSON.stringify(e)}\n\n`).join('')+(chat?'data: [DONE]\n\n':''),{headers:{'content-type':'text/event-stream'}})
}})
try{
 const db=await mf.getD1Database('DB')
 for(const file of(await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(f=>f.endsWith('.sql')).sort())for(const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${file}`,'utf8')))await db.prepare(sql).run()
 const now=new Date().toISOString()
 await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind('owner','Synthetic','synthetic@example.invalid',now).run()
 await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)').bind('key','Synthetic','raw-key',now,'owner',86400).run()
 for(const [id,endpoint]of [['up_chat','chat_completions'],['up_responses','responses']])await db.prepare('INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,'owner','custom',id,JSON.stringify({name:id,baseUrl:`https://synthetic.invalid/${id}`,authStyle:'none',endpoints:[endpoint],models:['synthetic-model']}),'[{"id":"direct_fetch"}]',now,now).run()
 const request=(id,input,stream,extra={})=>mf.dispatchFetch('http://local/v1/responses',{method:'POST',headers:{authorization:'Bearer raw-key','content-type':'application/json'},body:JSON.stringify({model:`${id}/synthetic-model`,input,stream,...extra})})
 const events=text=>text.split('\n').filter(l=>l.startsWith('data: ')&&l!=='data: [DONE]').map(l=>JSON.parse(l.slice(6)))
 const cases=[]
 for(const stream of [true,false])for(const mode of ['late-output','late-error','tail-frames','late-usage']){
  const id=mode==='late-usage'?'up_chat':'up_responses',r=await request(id,mode,stream),text=await r.text(),ev=stream?events(text):[]
  if(mode==='late-error'||mode==='tail-frames'){
   assert(r.status>=400||ev.some(e=>e.type==='error'||e.type==='response.failed'),text);assert(!ev.some(e=>e.type==='response.completed'))
  }else{
   assert.equal(r.status,200,text);assert(!text.includes('MUST-NOT-LEAK'));if(stream)assert.equal(ev.at(-1).type,'response.completed')
   const final=stream?ev.at(-1).response:JSON.parse(text);assert.equal(final.usage.output_tokens,mode==='late-usage'?17:7,text)
   const previous=await request(id,[{role:'user',content:'next immediately'}],false,{previous_response_id:final.id});assert.equal(previous.status,200,await previous.text())
  }
  cases.push(`${mode}-${stream?'sse':'json'}`)
 }
 const drained=await(await mf.dispatchFetch('http://local/__fixture/drain')).json();assert.equal(drained.pending,0)
 console.log(JSON.stringify({passed:true,runtime:'actual authenticated workerd/WebCrypto/D1 Responses turn',cases,calls:calls.length,scratch}))
}finally{await mf.dispose()}
