import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {Database} from 'bun:sqlite'

export async function createFixture(root) {
  assert(root)
  const source=`${root}/vnext`
  const {bootstrapBunPlatform}=await import(`${source}/apps/platform-bun/src/bootstrap.ts`)
  const {initBackground,initSocketDial}=await import(`${source}/packages/platform/src/index.ts`)
  const {getRepo}=await import(`${source}/packages/gateway/src/repo/index.ts`)
  const scratch=await mkdtemp(`${tmpdir()}/c12-f2-session-`)
  const dbPath=`${scratch}/fixture.sqlite`
  const {db}=bootstrapBunPlatform({dbPath,filesRoot:`${scratch}/files`})
  const external=new Database(dbPath)
  const pending=[]
  const background={waitUntil:p=>pending.push(p)}
  initBackground(background)
  initSocketDial(async()=>{throw new Error('External socket blocked')})
  const now=new Date().toISOString(),calls=[],closes=[]
  for(const id of ['owner','other'])await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind(id,'Synthetic',`${id}@example.invalid`,now).run()
  for(const id of ['key','other-key','durable'])await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)').bind(id,id,`raw-${id}`,now,'owner',id==='durable'?86400:0).run()
  const child=spawn('node',['--input-type=module','-e',String.raw`
    import {createServer} from 'node:http'
    let serial=0;const held=new Map()
    const server=createServer(async(req,res)=>{
      if(req.url==='/_fixture/release'){for(const finish of held.values())finish();held.clear();res.end('released');return}
      let raw='';for await(const c of req)raw+=c
      const body=JSON.parse(raw),mode=JSON.stringify(body.input??body.messages),id='resp_fixture_'+(++serial)
      console.log(JSON.stringify({call:true,body,id}))
      res.writeHead(200,{'content-type':'text/event-stream'})
      const wire=e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n'
      const output=[{type:'message',id:'msg_'+serial,role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic answer',annotations:[]}]}]
      if(mode.includes('opaque-state'))output.unshift({type:'reasoning',id:'reason_'+serial,encrypted_content:'synthetic-opaque-source',summary:[{type:'summary_text',text:'Synthetic reasoning'}]})
      const response={id,object:'response',model:body.model,output,status:'completed',error:null,incomplete_details:null,usage:{input_tokens:5,output_tokens:7,total_tokens:12}}
      let timer
      res.on('close',()=>{clearInterval(timer);held.delete(id);console.log(JSON.stringify({closed:true,id,finished:res.writableEnded}))})
      if(req.url.endsWith('/chat/completions')){
        const base={id:'chat_'+serial,object:'chat.completion.chunk',model:body.model,created:0}
        for(const e of [
          {...base,choices:[{index:0,delta:{role:'assistant',content:'Synthetic answer'},finish_reason:null}]},
          {...base,choices:[{index:0,delta:{},finish_reason:'stop'}]},
          {...base,choices:[{index:0}],usage:{prompt_tokens:5,completion_tokens:7,total_tokens:12}}
        ])res.write('data: '+JSON.stringify(e)+'\n\n')
        res.end('data: [DONE]\n\n');return
      }
      res.write(wire({type:'response.created',response:{...response,status:'in_progress',output:[]}}))
      if(mode.includes('held-generation')){held.set(id,()=>{clearInterval(timer);res.end(wire({type:'response.completed',response}))});timer=setInterval(()=>res.write(': waiting\n\n'),100);return}
      if(mode.includes('fail-generation')){res.end(wire({type:'response.failed',response:{...response,status:'failed',output:[],error:{code:'invalid_prompt',message:'Synthetic failure'}}}));return}
      res.end(wire({type:'response.completed',response}))
    })
    server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})))
  `],{stdio:['ignore','pipe','inherit']})
  let lines='',port
  child.stdout.on('data',chunk=>{lines+=chunk.toString();let at;while((at=lines.indexOf('\n'))>=0){const r=JSON.parse(lines.slice(0,at));lines=lines.slice(at+1);if(r.port)port=r.port;if(r.call)calls.push(r);if(r.closed)closes.push(r)}})
  const until=async(predicate,ms=5000)=>{const end=performance.now()+ms;while(!predicate()&&performance.now()<end)await new Promise(r=>setTimeout(r,10));assert(predicate(),'Fixture condition timed out')}
  await until(()=>port)
  for(const [id,endpoint]of [['up_responses','responses'],['up_chat','chat_completions']])await getRepo().upstreams.save({id,ownerId:'owner',provider:'custom',name:id,enabled:true,sortOrder:0,config:{name:id,baseUrl:`http://127.0.0.1:${port}/${id}`,authStyle:'none',endpoints:[endpoint],models:['synthetic-model']},state:{},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[{id:'direct_fetch'}],createdAt:now,updatedAt:now})
  return {source,scratch,db,external,upstreamBase:`http://127.0.0.1:${port}`,background,pending,calls,closes,until,getRepo,async finish(){await Promise.allSettled(pending);external.close();child.kill('SIGTERM')}}
}
