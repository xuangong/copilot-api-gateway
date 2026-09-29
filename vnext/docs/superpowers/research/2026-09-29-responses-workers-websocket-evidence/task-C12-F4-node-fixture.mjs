import {createServer} from 'node:http'

let gatewayBase
let failNext=false
let serial=0
const upstreamRequests=[]
const upstreamCloses=[]
const held=new Map()
const json=(res,value,status=200)=>{
  const body=JSON.stringify(value)
  res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(body),'connection':'close'})
  res.end(body)
}
const sse=event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
async function bodyOf(req){
  const chunks=[];let bytes=0
  for await(const chunk of req){bytes+=chunk.length;if(bytes>2_097_152)throw new Error('fixture request too large');chunks.push(chunk)}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
const server=createServer((req,res)=>{void (async()=>{
  const path=new URL(req.url,'http://127.0.0.1').pathname
  if(req.method==='POST'&&path==='/__fixture/config-gateway'){
    const value=await bodyOf(req)
    if(!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(value.gatewayBase))return json(res,{error:'loopback gateway required'},400)
    gatewayBase=value.gatewayBase;return json(res,{configured:true})
  }
  if(req.method==='GET'&&path==='/__fixture/c12'){
    if(!gatewayBase)return json(res,{error:'gateway unavailable'},503)
    const summary=new URL(req.url,'http://127.0.0.1').searchParams.get('summary')==='1'
    const response=await fetch(`${gatewayBase}/__fixture/c12-observation${summary?'?summary=1':''}`)
    if(!response.ok)return json(res,{error:'observer unavailable',status:response.status},502)
    const observed=await response.json()
    if(observed.observer_error)return json(res,{error:'passive observer failed'},500)
    return json(res,{schema_version:1,connections:observed.connections,upstream_requests:upstreamRequests,upstream_closes:upstreamCloses,http_posts:observed.http_posts})
  }
  if(req.method==='POST'&&path==='/__fixture/c12/fail-next'){failNext=true;return json(res,{armed:true})}
  if(req.method==='POST'&&path==='/__fixture/release'){
    let released=0
    for(const finish of held.values()){finish();released++}
    held.clear()
    return json(res,{released})
  }
  if(req.method!=='POST'||path!=='/v1/responses')return json(res,{error:'unexpected fixture route'},404)
  const body=await bodyOf(req)
  upstreamRequests.push(body)
  const failed=failNext;failNext=false
  const id=`resp_c12_f4_fixture_${++serial}`
  const mode=JSON.stringify(body.input??body.messages)
  const base={id,object:'response',model:'gpt-5.4',output:[],error:null,incomplete_details:null,usage:{input_tokens:0,input_tokens_details:null,output_tokens:0,output_tokens_details:null,total_tokens:0}}
  const created={type:'response.created',response:{...base,status:'in_progress'}}
  const terminal=failed?{type:'response.failed',response:{...base,status:'failed',error:{code:'invalid_prompt',message:'synthetic C12 upstream failure'}}}:{type:'response.completed',response:{...base,status:'completed'}}
  let timer
  res.on('close',()=>{if(timer)clearInterval(timer);held.delete(id);upstreamCloses.push({id,mode,finished:res.writableEnded})})
  if(mode.includes('held-generation')){
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write(sse(created))
    held.set(id,()=>res.end(sse(terminal)))
    if(!mode.includes('silent-held-generation'))timer=setInterval(()=>res.write(': held\n\n'),100)
    return
  }
  if(mode.includes('pressure-flood')||mode.includes('lifetime-partial')){
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write(sse(created))
    const delta='p'.repeat(240_000)
    const count=mode.includes('lifetime-partial')?36:80
    for(let index=0;index<count&&!res.destroyed;index++){
      const ok=res.write(sse({type:'response.output_text.delta',item_id:`item_${id}`,output_index:0,content_index:0,delta,probe_index:index}))
      if(!ok&&!res.destroyed)await new Promise(resolve=>{
        const done=()=>{res.off('drain',done);res.off('close',done);resolve()}
        res.once('drain',done);res.once('close',done)
      })
    }
    if(!res.destroyed){
      if(mode.includes('lifetime-partial'))res.end(sse(terminal))
      else timer=setInterval(()=>res.write(': held\n\n'),100)
    }
    return
  }
  if(mode.includes('large-lifetime')){
    const padding='l'.repeat(240_000)
    const wire=sse(created)+Array.from({length:3},(_,index)=>sse({type:'response.in_progress',response:{id,status:'in_progress'},probe_index:index,probe_padding:padding})).join('')+sse(terminal)
    res.writeHead(200,{'content-type':'text/event-stream','content-length':Buffer.byteLength(wire),'connection':'close'})
    res.end(wire)
    return
  }
  const late=mode.includes('late-terminal')?sse({type:'response.output_text.delta',item_id:'late',output_index:0,content_index:0,delta:'MUST-NOT-LEAK'}):''
  const wire=sse(created)+sse(terminal)+late
  res.writeHead(200,{'content-type':'text/event-stream','content-length':Buffer.byteLength(wire),'connection':'close'})
  res.end(wire)
})().catch(error=>{if(!res.headersSent)json(res,{error:'fixture failure',message:String(error)},500);else res.destroy()})})
server.listen(0,'127.0.0.1',()=>{
  const address=server.address()
  console.log(JSON.stringify({fixtureBase:`http://127.0.0.1:${address.port}`}))
})
process.once('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0))})
process.once('SIGINT',()=>{server.closeAllConnections();server.close(()=>process.exit(0))})
