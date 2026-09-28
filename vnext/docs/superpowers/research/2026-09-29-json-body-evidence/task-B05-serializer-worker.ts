import { createJsonBody, createJsonBodyFromText, type ReplayableJsonBody } from "../../../../packages/provider-llm/src/json-body.ts"
const encoder=new TextEncoder()
async function drain(body:ReplayableJsonBody) {
  const reader=body.open().getReader()
  const all=new Uint8Array(body.contentLength)
  let length=0,maxChunk=0,chunks=0
  try { for (;;) {
    const result=await reader.read()
    if(result.done) break
    const bytes=result.value
    if(bytes.length<1 || bytes.length>65536) throw new Error("chunk bound")
    maxChunk=Math.max(maxChunk,bytes.length);chunks++
    all.set(bytes,length);length+=bytes.length
  }} finally {reader.releaseLock()}
  if(length!==body.contentLength) throw new Error("length mismatch")
  return {all,length,maxChunk,chunks}
}
export default {
  async fetch() {
    const source={ ["key\ud83d\ude00".repeat(4000)]: "\n\u0000\"\\漢😀\ud800".repeat(70000), overflow: null, arr:[-0,1e21,null,true] }
    const text=JSON.stringify(source)
    const expected=encoder.encode(text)
    const results=[]
    for(const body of [createJsonBody(source),createJsonBodyFromText(text)]) {
      const first=body.open().getReader();const item=await first.read();item.value?.fill(0);await first.cancel();first.releaseLock()
      const abort=new AbortController(), cancelled=body.open(abort.signal).getReader()
      await cancelled.read();abort.abort(new Error("synthetic abort"));let rejected=false
      try {await cancelled.read()}catch{rejected=true}finally{cancelled.releaseLock()}
      if(!rejected)throw new Error("abort failed")
      const output=await drain(body)
      if(output.length!==expected.length || !output.all.every((b,i)=>b===expected[i]))throw new Error("native bytes differ")
      results.push({mode:body.mode,length:output.length,maxChunk:output.maxChunk,chunks:output.chunks,replayAfterMutation:true,aborted:true})
    }
    const overflow=await drain(createJsonBodyFromText('{"v":1e400}'))
    if(new TextDecoder().decode(overflow.all)!=='{"v":null}')throw new Error("overflow normalization")
    return Response.json({runtime:"local workerd",passed:true,results,overflowNormalized:true})
  }
}
