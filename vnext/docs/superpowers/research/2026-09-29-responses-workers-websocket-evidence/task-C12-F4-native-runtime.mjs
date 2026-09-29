import assert from 'node:assert/strict'
import {connect} from 'node:net'
import {createFixture} from './task-C12-F4-runtime-fixture.mjs'

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(read,predicate,label,ms=5000){
  const end=Date.now()+ms
  while(Date.now()<end){
    const value=await read()
    if(predicate(value))return value
    await sleep(20)
  }
  throw new Error(`${label} timed out`)
}
const create=extra=>JSON.stringify({type:'response.create',model:'gpt-5.4',input:'hello',stream:true,store:false,...extra})
const errorCode=event=>event?.error?.code
const responseId=event=>event?.response?.id

async function handshake(port,path,headers={}){
  const socket=connect(Number(port),'127.0.0.1')
  try{
    return await new Promise((resolve,reject)=>{
      let head=''
      socket.setTimeout(5000,()=>reject(new Error('handshake timeout')))
      socket.once('error',reject)
      socket.on('data',chunk=>{
        head+=chunk.toString()
        if(!head.includes('\r\n\r\n'))return
        const match=/^HTTP\/1\.1 (\d{3})/.exec(head)
        if(!match)reject(new Error(`invalid handshake: ${head.slice(0,80)}`))
        else resolve(Number(match[1]))
      })
      socket.write([
        `GET ${path} HTTP/1.1`,`Host: 127.0.0.1:${port}`,
        'Connection: keep-alive, Upgrade','Upgrade: websocket',
        'Sec-WebSocket-Key: AQIDBAUGBwgJCgsMDQ4PEA==','Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([key,value])=>`${key}: ${value}`),'','',
      ].join('\r\n'))
    })
  }finally{socket.destroy()}
}

async function open(f,credential=f.key){
  const port=new URL(f.gatewayBase).port
  const socket=new WebSocket(`ws://127.0.0.1:${port}/v1/responses`,{headers:{authorization:`Bearer ${credential}`}})
  const events=[]
  socket.addEventListener('message',message=>events.push(JSON.parse(message.data)))
  await new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true})
    socket.addEventListener('error',()=>reject(new Error('native WebSocket open failed')),{once:true})
  })
  return {socket,events,send:extra=>socket.send(create(extra)),close:()=>socket.close(1000,'matrix complete')}
}

const f=await createFixture({directNetwork:true})
const connections=[]
const cases=[]
try{
  const port=new URL(f.gatewayBase).port
  const routes=['/responses','/v1/responses','/azure-api.codex/responses','/azure-api.codex/v1/responses']
  const routeStatuses=[]
  for(const path of routes)routeStatuses.push(await handshake(port,path,{authorization:`Bearer ${f.key}`}))
  assert.deepEqual(routeStatuses,[101,101,101,101])
  assert.equal(await handshake(port,'/v1/responses'),401)
  assert.equal(await handshake(port,'/v1/responses',{authorization:'Bearer invalid'}),401)
  assert.equal(await handshake(port,`/v1/responses?key=${f.key}`,{authorization:`Bearer ${f.key}`}),400)
  assert.equal(await handshake(port,'/v1/responses',{cookie:`session_token=${f.key}`}),401)
  assert.equal(await handshake(port,'/v1/responses/compact',{authorization:`Bearer ${f.key}`}),404)
  assert.equal((await fetch(`${f.gatewayBase}/health`)).status,200)
  assert.equal((await fetch(`${f.gatewayBase}/v1/responses`)).status,404)
  const incomplete=await fetch(`${f.gatewayBase}/v1/responses`,{headers:{upgrade:'websocket'}})
  assert.equal(incomplete.status,404)
  const http=await fetch(`${f.gatewayBase}/v1/responses`,{method:'POST',headers:{authorization:`Bearer ${f.key}`,'content-type':'application/json'},body:JSON.stringify({model:'gpt-5.4',input:'HTTP unchanged',stream:false,store:false})})
  assert.equal(http.status,200,await http.text())
  const routeObservation=await f.observe()
  assert.equal(routeObservation.connections.length,4)
  assert.equal(routeObservation.http_posts,1)
  assert.equal(routeObservation.upstream_requests.length,1)
  cases.push({case:'routes_auth_http',routeStatuses,unauthorized:401,queryCredential:400,cookieOnly:401,compact:404,httpPost:200,acceptedPairs:4})

  const chain=await open(f);connections.push(chain)
  const callsBefore=(await f.observe()).upstream_requests.length
  chain.send({generate:false,instructions:'remember',tools:[{type:'function',name:'lookup',parameters:{type:'object',properties:{}}}]})
  await until(()=>chain.events,events=>events.some(event=>event.type==='response.completed'),'warmup')
  assert.deepEqual(chain.events.map(event=>event.type),['response.created','response.completed'])
  const warmId=responseId(chain.events[1])
  assert.equal(responseId(chain.events[0]),warmId)
  assert.equal((await f.observe()).upstream_requests.length,callsBefore)
  chain.send({previous_response_id:warmId,input:[]})
  await until(()=>chain.events,events=>events.filter(event=>event.type==='response.completed').length===2,'continuation')
  const afterChain=await f.observe()
  assert.equal(afterChain.upstream_requests.length,callsBefore+1)
  const upstream=afterChain.upstream_requests.at(-1)
  assert.match(JSON.stringify(upstream),/remember/)
  assert.match(JSON.stringify(upstream),/hello/)
  assert.match(JSON.stringify(upstream),/lookup/)
  assert.equal(upstream.previous_response_id,undefined)
  const other=await open(f);connections.push(other)
  other.send({previous_response_id:warmId,input:[]})
  await until(()=>other.events,events=>events.some(event=>event.type==='error'),'private continuation')
  assert.equal(errorCode(other.events.at(-1)),'previous_response_not_found')
  assert.equal((await f.observe()).upstream_requests.length,callsBefore+1)
  cases.push({case:'warmup_full_private',warmupId:warmId,warmupUpstreamCalls:0,continuationUpstreamCalls:1,crossConnectionError:errorCode(other.events.at(-1))})

  const armed=await fetch(`${f.fixtureBase}/__fixture/c12/fail-next`,{method:'POST'})
  assert.equal(armed.status,200)
  const failed=await open(f);connections.push(failed)
  failed.send({input:'synthetic failure'})
  await until(()=>failed.events,events=>events.some(event=>event.type==='response.failed'),'failed response')
  assert.equal(failed.events.at(-1).type,'response.failed')
  const recovered=await open(f);connections.push(recovered)
  recovered.send({input:'full fresh recovery'})
  await until(()=>recovered.events,events=>events.some(event=>event.type==='response.completed'),'fresh recovery')
  assert.equal(recovered.events.at(-1).type,'response.completed')
  const late=await open(f);connections.push(late)
  late.send({input:'late-terminal'})
  await until(()=>late.events,events=>events.some(event=>event.type==='response.completed'),'late terminal')
  await sleep(150)
  assert.equal(late.events.at(-1).type,'response.completed')
  assert.equal(JSON.stringify(late.events).includes('MUST-NOT-LEAK'),false)
  cases.push({case:'failure_recovery_terminal_last',failedTerminal:failed.events.at(-1).type,recoveryTerminal:recovered.events.at(-1).type,lateLeaked:false})

  const now=new Date().toISOString(),future=new Date(Date.now()+3600000).toISOString(),token='ses_c12_f4_synthetic'
  await f.db.prepare('INSERT INTO user_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind(token,'c12-f4-owner',now,future).run()
  const session=await open(f,token);connections.push(session)
  session.send({generate:false})
  await until(()=>session.events,events=>events.some(event=>event.type==='response.completed'),'session warmup')
  await f.db.prepare('DELETE FROM user_sessions WHERE token = ?').bind(token).run()
  const beforeSession=(await f.observe()).upstream_requests.length
  session.send({input:'after session revocation'})
  await until(()=>session.events,events=>events.some(event=>event.type==='error'),'session revocation')
  assert.equal(session.events.at(-1).status,401)
  assert.equal((await f.observe()).upstream_requests.length,beforeSession)
  const owner=await open(f);connections.push(owner)
  owner.send({generate:false})
  await until(()=>owner.events,events=>events.some(event=>event.type==='response.completed'),'owner warmup')
  await f.db.prepare("UPDATE users SET disabled=1 WHERE id='c12-f4-owner'").run()
  const beforeOwner=(await f.observe()).upstream_requests.length
  owner.send({input:'after owner revocation'})
  await until(()=>owner.events,events=>events.some(event=>event.type==='error'),'owner revocation')
  assert.equal(owner.events.at(-1).status,401)
  assert.equal((await f.observe()).upstream_requests.length,beforeOwner)
  await f.db.prepare("UPDATE users SET disabled=0 WHERE id='c12-f4-owner'").run()
  const key=await open(f);connections.push(key)
  key.send({generate:false})
  await until(()=>key.events,events=>events.some(event=>event.type==='response.completed'),'key warmup')
  await f.db.prepare("DELETE FROM api_keys WHERE id='c12-f4-key'").run()
  const beforeKey=(await f.observe()).upstream_requests.length
  key.send({input:'after key revocation'})
  await until(()=>key.events,events=>events.some(event=>event.type==='error'),'key revocation')
  assert.equal(key.events.at(-1).status,401)
  assert.equal((await f.observe()).upstream_requests.length,beforeKey)
  cases.push({case:'external_d1_revocation',session:401,owner:401,key:401,extraUpstreamCalls:0})

  console.log(JSON.stringify({nativeWorkerdMatrix:true,directNetwork:true,compatibilityDate:'2025-06-01',migrations:f.migrations.length,cases},null,2))
}finally{
  for(const connection of connections)connection.close()
  await f.stop()
}
