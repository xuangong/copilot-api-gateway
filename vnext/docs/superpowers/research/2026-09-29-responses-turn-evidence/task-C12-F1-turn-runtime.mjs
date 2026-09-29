import assert from 'node:assert/strict'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const {createResponsesTurn}=await import(`${root}/vnext/packages/gateway/src/data-plane/chat-flow/responses/turn.ts`)
const {eventFrame}=await import(`${root}/vnext/packages/result/src/index.ts`)
const {llmEventResult}=await import(`${root}/vnext/packages/protocols-llm/src/common/index.ts`)
const {initBackground}=await import(`${root}/vnext/packages/platform/src/index.ts`)
const pending=[];initBackground({waitUntil:p=>pending.push(p)})
const identity={incomingModel:'synthetic',model:'synthetic',modelKey:'synthetic',upstream:'synthetic',cost:null}
const response={id:'synthetic-terminal',object:'response',model:'synthetic',output:[],status:'completed',error:null,incomplete_details:null}
const terminal={type:'response.completed',response}
const late={type:'response.output_text.delta',item_id:'tail',output_index:0,content_index:0,delta:'MUST-NOT-LEAK'}
const cases=[]
const collect=async turn=>{const values=[];for await(const event of turn.events)values.push(event);return values}
const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Unbounded completion')),4500)})])}finally{clearTimeout(timer)}}
for(const [label,status,source]of[
 ['late-output','completed',async function*(){yield eventFrame(terminal);yield eventFrame(late)}],
 ['late-error','failed',async function*(){yield eventFrame(terminal);throw Error('synthetic-late-error')}],
 ['failed-tail','failed',async function*(){yield eventFrame({type:'response.failed',response:{...response,status:'failed',error:{code:'upstream',message:'synthetic'}}});yield eventFrame(late)}],
 ['incomplete-tail','incomplete',async function*(){yield eventFrame({type:'response.incomplete',response:{...response,status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}});yield eventFrame(late)}],
]){
 const before=pending.length,turn=createResponsesTurn(llmEventResult(source(),identity),{wantsStream:true});assert(pending.length>before,'Completion not registered at turn creation')
 const values=await bounded(collect(turn)),completion=await bounded(turn.completion)
 assert(!JSON.stringify(values).includes('MUST-NOT-LEAK'));assert.equal(values.length,1);assert.equal(completion.outcome,status)
 assert.equal(Boolean(completion.response),status==='completed');cases.push(label)
}
{
 let count=0,returnCalled=false;const upstream=new AbortController()
 const source={ [Symbol.asyncIterator](){return this},next(){return count++===0?Promise.resolve({done:false,value:eventFrame(terminal)}):new Promise(()=>{})},return(){returnCalled=true;return new Promise(()=>{})}}
 const turn=createResponsesTurn(llmEventResult(source,identity),{wantsStream:true,upstreamAbortController:upstream})
 const started=performance.now(),values=await bounded(collect(turn)),completion=await bounded(turn.completion)
 assert.equal(completion.outcome,'failed');assert(!completion.response);assert(upstream.signal.aborted);assert(!turn.abortController.signal.aborted);assert(values.every(v=>v.type!=='response.completed'));assert(performance.now()-started<4500)
 cases.push({label:'hostile-next-return-bounded',returnCalled,cleanupComplete:completion.cleanupComplete})
}
{
 let release,entered=false,completed=false;const gate=new Promise(r=>{release=r})
 async function* source(){yield eventFrame(terminal)}
 const turn=createResponsesTurn(llmEventResult(source(),identity),{wantsStream:true,onCompleted:async()=>{entered=true;await gate}})
 turn.completion.then(()=>{completed=true})
 const values=[],read=(async()=>{for await(const event of turn.events)values.push(event)})()
 for(let i=0;i<100&&!entered;i++)await new Promise(r=>setTimeout(r,5))
 assert(entered);assert.equal(values.length,0);assert(!completed);turn.abortController.abort();await new Promise(r=>setTimeout(r,20));assert(!completed,'Completion settled while owned durable save pending')
 release();await bounded(read);const completion=await bounded(turn.completion)
 assert.equal(completion.outcome,'cancelled');assert(!completion.response);assert.equal(values.length,0);cases.push('save-cancel-owns-cleanup-no-reuse')
}
{
 let returned=false;const upstream=new AbortController()
 const source={ [Symbol.asyncIterator](){return this},next(){return new Promise(()=>{})},return(){returned=true;return Promise.resolve({done:true})}}
 const turn=createResponsesTurn(llmEventResult(source,identity),{wantsStream:true,upstreamAbortController:upstream})
 await turn.ready;turn.abortController.abort();const completion=await bounded(turn.completion)
 assert.equal(completion.outcome,'cancelled');assert(upstream.signal.aborted);assert(returned,'Unconsumed upstream iterator was not released')
 cases.push('abort-before-consumption-releases-source')
}
await bounded(Promise.all(pending))
console.log(JSON.stringify({passed:true,cases}))
