import {readdir,readFile,writeFile,mkdtemp} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const {Miniflare}=await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
const {unstable_splitSqlQuery}=await import(`${root}/vnext/node_modules/.bun/wrangler@4.97.0+01d2f64f02d20ae6/node_modules/wrangler/wrangler-dist/cli.js`)
const scratch=await mkdtemp(`${tmpdir()}/c01-clients-d1-`),entry=`${scratch}/worker.ts`,bundle=`${scratch}/worker.mjs`
await writeFile(entry,(await readFile(new URL('./task-C01-integration-worker.ts.txt',import.meta.url),'utf8')).replaceAll('__ROOT__',root))
const build=spawnSync('bun',['build',entry,'--target=node',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'});assert.equal(build.status,0,build.stderr)
const calls=[];let serial=0
const thought='  Synthetic thought \n'
const mf=new Miniflare({modules:true,modulesRoot:scratch,scriptPath:bundle,compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'c01-clients'},r2Buckets:{FILES:'c01-files'},outboundService:async req=>{
 assert.equal(new URL(req.url).hostname,'synthetic.invalid');const body=await req.json();calls.push(body);serial++
 const path=new URL(req.url).pathname
 let result,frames
 if(path.endsWith('/messages')){
  const content=[{type:'thinking',thinking:thought,signature:'synthetic-opaque'},{type:'text',text:'Synthetic answer'}]
  result={id:`msg_${serial}`,type:'message',role:'assistant',model:body.model,content,stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}
  frames=[{type:'message_start',message:{...result,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:content[0]},{type:'content_block_stop',index:0},{type:'content_block_start',index:1,content_block:content[1]},{type:'content_block_stop',index:1},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}]
 }else if(path.endsWith('/chat/completions')){
  result={id:`chat_${serial}`,object:'chat.completion',created:0,model:body.model,choices:[{index:0,message:{role:'assistant',content:'Synthetic answer',reasoning_content:thought,reasoning_opaque:'synthetic-opaque'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}
  frames=[{...result,object:'chat.completion.chunk',choices:[{index:0,delta:result.choices[0].message,finish_reason:null}]},{...result,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]}]
 }else{
  const item={id:`rs_${serial}`,type:'reasoning',summary:[{type:'summary_text',text:thought}],encrypted_content:'synthetic-opaque'}
  result={id:`resp_${serial}`,object:'response',model:body.model,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}
  frames=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:result}]
 }
 if(!body.stream)return Response.json(result)
 return new Response(frames.map(e=>`${e.type?`event: ${e.type}\n`:''}data: ${JSON.stringify(e)}\n\n`).join('')+(path.endsWith('/chat/completions')?'data: [DONE]\n\n':''),{headers:{'content-type':'text/event-stream'}})
}})
try{
 const db=await mf.getD1Database('DB')
 for(const file of(await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(f=>f.endsWith('.sql')).sort())for(const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${file}`,'utf8')))await db.prepare(sql).run()
 const now=new Date().toISOString()
 await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind('owner','Synthetic','synthetic@example.invalid',now).run()
 for(const key of ['key','other'])await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)').bind(key,key,`raw-${key}`,now,'owner').run()
 for(const [id,endpoint] of [['up_chat','chat_completions'],['up_messages','messages'],['up_responses','responses']])await db.prepare('INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,'owner','custom',id,JSON.stringify({name:id,baseUrl:`https://synthetic.invalid/${id}`,authStyle:'none',endpoints:[endpoint],models:['synthetic-model']}),'[{"id":"direct_fetch"}]',now,now).run()
 const request=async(protocol,id,stream,input,key='key')=>{
  const path=protocol==='chat'?'/v1/chat/completions':`/v1beta/models/${encodeURIComponent(`${id}/synthetic-model`)}:${stream?'streamGenerateContent':'generateContent'}`
  const body=protocol==='chat'?{model:`${id}/synthetic-model`,messages:input??[{role:'user',content:'synthetic'}],stream}:{contents:input??[{role:'user',parts:[{text:'synthetic'}]}],generationConfig:{thinkingConfig:{includeThoughts:true}}}
  const r=await mf.dispatchFetch('http://local'+path,{method:'POST',headers:{authorization:`Bearer raw-${key}`,'content-type':'application/json'},body:JSON.stringify(body)});const text=await r.text();return{status:r.status,text,json:!stream?JSON.parse(text):null}
 }
 const cases=[]
 for(const protocol of ['chat','gemini'])for(const id of ['up_chat','up_messages','up_responses'])for(const stream of [false,true]){
  const r=await request(protocol,id,stream);assert.equal(r.status,200,r.text)
  const events=stream?r.text.split('\n').filter(l=>l.startsWith('data: ')&&l!=='data: [DONE]').map(l=>JSON.parse(l.slice(6))):[]
  let message
  if(protocol==='chat'){
   message=stream?{role:'assistant',content:'',reasoning_content:'',reasoning_opaque:''}:r.json.choices[0].message
   if(stream)for(const e of events)for(const c of e.choices??[]){const d=c.delta??{};message.content+=d.content??'';message.reasoning_content+=d.reasoning_text??d.reasoning_content??d.reasoning??'';message.reasoning_opaque+=d.reasoning_opaque??''}
   assert(message.reasoning_opaque?.startsWith('vnext-affinity:'),r.text);assert.equal(message.reasoning_text??message.reasoning_content??message.reasoning,thought)
  }else{
   message=stream?{role:'model',parts:events.flatMap(e=>(e.candidates??[]).flatMap(c=>c.content?.parts??[]))}:r.json.candidates[0].content
   const signed=message.parts.find(p=>p.thoughtSignature);assert(signed?.thoughtSignature.startsWith('vnext-affinity:'),r.text);assert.equal(signed.text,thought)
  }
  const input=[message,protocol==='chat'?{role:'user',content:'next'}:{role:'user',parts:[{text:'next'}]}]
  const replay=await request(protocol,id,false,input);assert.equal(replay.status,200,replay.text);assert(JSON.stringify(calls.at(-1)).includes('synthetic-opaque'))
  const before=calls.length,bad=await request(protocol,id,false,input,'other');assert(bad.status>=400,bad.text);assert.equal(calls.length,before);cases.push(`${protocol}-${id}-${stream?'sse':'json'}-replay-wrongkey`)
 }
 await(await mf.dispatchFetch('http://local/__fixture/drain')).text()
 console.log(JSON.stringify({passed:true,runtime:'actual app/workerd/WebCrypto/D1 Chat/Gemini through all three hubs',cases,calls:calls.length,scratch}))
}finally{await mf.dispose()}
