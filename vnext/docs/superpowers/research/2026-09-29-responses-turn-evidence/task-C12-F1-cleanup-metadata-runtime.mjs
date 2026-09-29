import assert from 'node:assert/strict'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const {createResponsesTurn}=await import(`${root}/vnext/packages/gateway/src/data-plane/chat-flow/responses/turn.ts`)
const {eventFrame}=await import(`${root}/vnext/packages/result/src/index.ts`)
const {llmEventResult}=await import(`${root}/vnext/packages/protocols-llm/src/common/index.ts`)
const {initBackground}=await import(`${root}/vnext/packages/platform/src/index.ts`)
initBackground({waitUntil:()=>{}})
const identity={incomingModel:'synthetic',model:'synthetic',modelKey:'synthetic',upstream:'synthetic',cost:null}
let count=0
const frames={ [Symbol.asyncIterator](){return this},next(){return count++===0?Promise.resolve({done:false,value:eventFrame({type:'response.completed',response:{id:'synthetic',object:'response',output:[],status:'completed'}})}):new Promise(()=>{})},return(){return new Promise(()=>{})}}
const result={...llmEventResult(frames,identity),finalMetadata:new Promise(()=>{}),__interceptorReplaced:true}
const dump={frame(){},failed(){},cancelled(){},success(){},async finalizeTurn(){}}
const turn=createResponsesTurn(result,{wantsStream:true,dump,finalizeDump:true})
const values=[],started=performance.now()
const read=(async()=>{for await(const e of turn.events)values.push(e)})()
let timer
try{
 const completion=await Promise.race([Promise.all([read,turn.completion]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Cleanup hung waiting for failed producer finalMetadata')),5500)})])
 assert.equal(completion[1].outcome,'failed');assert(!completion[1].response);assert(values.every(e=>e.type!=='response.completed'))
 console.log(JSON.stringify({passed:true,elapsedMs:performance.now()-started,completion:completion[1]}))
}finally{clearTimeout(timer);turn.abortController.abort()}
