import { describe, expect, test } from "bun:test"
import { createHash, createCipheriv, hkdfSync } from "node:crypto"
import { verifyReferenceReadback } from "./reference-oracle"
const sha = (v: string) => createHash("sha256").update(v).digest("hex")
function carrier() {
  const key=hkdfSync("sha256",Buffer.from(sha("reference-measurement-only:independent-fixture-key"),"hex"),Buffer.from("Floway server secret v1"),Buffer.from("client-carried affinity v1"),32),iv=Buffer.alloc(12,1),cipher=createCipheriv("aes-256-gcm",Buffer.from(key),iv)
  const domain=Buffer.from("openai-chat-completions.reasoning_opaque"),mark=Buffer.alloc(2);mark.writeUInt16BE(domain.length);cipher.setAAD(Buffer.concat([mark,domain]))
  const data=JSON.stringify({version:2,affinity:{upstreamId:"custom:reference-fixture",modelId:"bench-chat-ok"},opaqueBlobCompatibilityIdentity:{key:"bench-chat-ok"}})
  const encrypted=Buffer.concat([iv,cipher.update(data),cipher.final(),cipher.getAuthTag()]),length=Buffer.alloc(2);length.writeUInt16BE(encrypted.length)
  return Buffer.concat([encrypted,length]).toString("base64")
}
const event = { id:"chatcmpl_one",object:"chat.completion",model:"bench-chat-ok",created:1, choices: [{ index: 0, message: { role: "assistant", content: "BENCH_OK:65536", reasoning_opaque:carrier() }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }
function fixture() {
  const requestBody = '{"model":"bench-chat-ok","stream":false,"messages":[{"role":"user","content":"BENCH_ID:one"}]}'
  const requestHeaders: [string,string][] = [["authorization","Bearer independent-fixture-key"],["content-type","application/json"],["x-benchmark-id","one"]]
  const responseHeaders: [string,string][] = [["content-type","application/json"]]
  const response = JSON.stringify(event)
  const row = { arm: "R" as const, id: "one", dumpRecordId: null, requestSha256: sha(requestBody), responseSha256: sha(response), wireBytes: Buffer.byteLength(requestBody), responseBytes: Buffer.byteLength(response), stream: false, status: 200, wireEvents: [event], wireDone: false, wireEvidence: { requestBody, response, parsedEvents: [event], done: false, requestHeaders, responseHeaders } }
  const descriptor = (side: string, type: string) => ({ key: `dumps/v1/reference-key/hour/record.${side}.gz`, type })
  const req = descriptor("req", "bytes"), resp = descriptor("resp", "bytes"), up = descriptor("resp.up", "capture")
  const envelope = { version: 1, capture: { response: { body: { encoding: "utf8", data: response }, complete: true, error: null }, exchanges: [{ upstreamId: "custom:reference-fixture", request: { method: "POST", url: "http://127.0.0.1:123/v1/chat/completions", headers: [], body: { encoding: "utf8", data: requestBody } }, response: { status: 200, headers: [], body: { encoding: "utf8", data: response }, complete: true, error: null }, error: null }] } }
  const objects = [[req, requestBody, "dump-request"], [resp, response, "dump-response"], [up, JSON.stringify(envelope), "dump-response-upstream"]].map(([d, text, ownerKind]) => { const desc = d as typeof req, body = text as string; return { key: desc.key, type: desc.type, size: 1, compressedSha256: sha("x"), decodedBytes: Buffer.byteLength(body), decodedSha256: sha(body), decodedBase64: Buffer.from(body).toString("base64"), owner: { type: desc.type, keyId: "reference-key", id: "record", ownerKind }, ...(desc.type === "capture" ? { json: envelope } : {}) } })
  const dims = { key_id: "reference-key", model: "bench-chat-ok", model_key: "bench-chat-ok", upstream: "custom:reference-fixture", hour: "2026100801", pricing_selector: "{}" }
  const storage = { schema: "reference-native-dump-v1", rows: [{ key_id: "reference-key", id: "record", upstream_id: dims.upstream, request_headers_json: JSON.stringify(requestHeaders), response_headers_json: JSON.stringify(responseHeaders), meta: { id: "record", method: "POST", path: "/v1/chat/completions", model: dims.model, status: 200, requestBytes: row.wireBytes, responseBytes: row.responseBytes, inputTokens: 7, outputTokens: 3, error: null, targetApi: null }, request_body_descriptor: req, response_body_descriptor: resp, response_upstream_body_descriptor: up }], files: objects.map(o => ({ file_key: o.key, state: "owned", owner_kind: o.owner.ownerKind, owner_key: JSON.stringify(["reference-key", "record"]) })), objects, ownershipIssues: [], historyCounts: { responses_snapshots: 0, responses_items: 0 }, tables: { usage: [{ ...dims, metric: "input_tokens", quantity: "7" }, { ...dims, metric: "output_tokens", quantity: "3" }], usage_requests: [{ ...dims, requests: 1 }], performance_summary: [{ ...dims, operation: "chat", runtime_location: "unknown", requests: 1, ttft_samples_ok: 1, errors_with_output: 0, errors_no_output: 0, neutral: 0, tpot_samples: 1, ttft_ms_sum: 5, tpot_us_sum: 2 }], performance_buckets: [{ ...dims, operation: "chat", runtime_location: "unknown", metric: "ttft_ms", lower: 0, upper: 10, count: 1 }, { ...dims, operation: "chat", runtime_location: "unknown", metric: "tpot_us", lower: 0, upper: 10, count: 1 }], responses_snapshots: [], responses_items: [] }, compressedBytes: 3, decodedBytes: objects.reduce((n,o)=>n+o.decodedBytes,0) }
  const dispatch = { id: "one", bodyBytes: row.wireBytes, requestSha256: sha(requestBody), responseBytes: row.responseBytes, responseSha256: sha(response), requestedStream: false, status: 200, completed: true, cancelled: false }
  return { storage, rows: [row], dispatches: [dispatch], envelope }
}
describe("reference native semantic oracle", () => {
  test("accepts native complete bytes/capture evidence", () => { const f = fixture(); expect(verifyReferenceReadback(f.storage, f.rows, f.dispatches).passed).toBe(true) })
  test("rejects same-length upstream body substitution", () => { const f = fixture(); f.dispatches[0]!.requestSha256 = sha("wrong"); expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow() })
  test("rejects incomplete raw response despite successful logical row", () => { const f=fixture(); f.envelope.capture.exchanges[0]!.response.complete=false; expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow() })
  test("rejects extra ownership and history", () => { const f=fixture(); f.storage.historyCounts.responses_items=1; expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow() })
  test("rejects duplicate offer identities", () => { const f=fixture(); expect(()=>verifyReferenceReadback(f.storage,[...f.rows,...f.rows],f.dispatches)).toThrow() })
  test("rejects extra usage metric and performance count", () => { const f=fixture(); f.storage.tables.usage.push({...f.storage.tables.usage[0]!,metric:"unexpected"}); expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow() })
  test("rejects an unreferenced object even with registered ownership", () => { const f=fixture(); f.storage.objects.push({...f.storage.objects[0]!,key:"extra"}); expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow() })
  test("rejects performance overcount with correct usage", () => { const f=fixture(); f.storage.tables.performance_summary[0]!.requests=2; expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow() })
  test("rejects duplicate aggregate usage rows", () => { const f=fixture(); const row=f.storage.tables.usage[0]!; row.quantity="0"; f.storage.tables.usage.push({...row,quantity:"7"}); expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow() })
  test("rejects raw evidence with reordered DONE", () => { const f=fixture(); f.rows[0]!.wireDone=true; expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow() })
  test("accepts JSON canonical source frames while preserving exact client capture", () => {
    const f=fixture(), wire=f.rows[0]!.wireEvents[0]!
    const frames=[{frame:{type:"event",event:{choices:[{index:0,delta:{role:"assistant"},finish_reason:null}]}},ts:0},{frame:{type:"event",event:{choices:[{index:0,delta:{content:"BENCH_OK:65536"},finish_reason:null}]}},ts:1},{frame:{type:"event",event:{choices:[{index:0,delta:{},finish_reason:"stop"}],usage:wire.usage}},ts:2},{frame:{type:"done"},ts:3}]
    for(const e of frames) if(e.frame.event) Object.assign(e.frame.event,{id:event.id,model:event.model,created:event.created,object:"chat.completion.chunk"})
    const raw=JSON.stringify(frames), physical=f.storage.objects[1]!
    physical.type="events"; physical.owner.type="events"; physical.decodedBase64=Buffer.from(raw).toString("base64"); physical.decodedBytes=Buffer.byteLength(raw); physical.decodedSha256=sha(raw)
    f.storage.rows[0]!.response_body_descriptor.type="events"; f.storage.decodedBytes=f.storage.objects.reduce((n,o)=>n+o.decodedBytes,0)
    expect(verifyReferenceReadback(f.storage,f.rows,f.dispatches).records[0]!.classification).toBe("canonical_source_semantics")
    frames[1]!.frame.event!.choices[0]!.delta={content:"BENCH_OK:wrong"} as never
    const wrong=JSON.stringify(frames); physical.decodedBase64=Buffer.from(wrong).toString("base64"); physical.decodedBytes=Buffer.byteLength(wrong); physical.decodedSha256=sha(wrong); f.storage.decodedBytes=f.storage.objects.reduce((n,o)=>n+o.decodedBytes,0)
    expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow()
  })

  test("accepts native pre-affinity SSE fidelity and DONE cancellation, rejects changed frames", () => {
    const f=fixture(), row=f.rows[0]!, dispatch=f.dispatches[0]!
    const events=[{choices:[{index:0,delta:{role:"assistant"},finish_reason:null}]},{choices:[{index:0,delta:{content:"BENCH_OK:65536"},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:"stop"}],usage:event.usage}]
    for(const e of events) Object.assign(e,{id:event.id,model:event.model,created:event.created,object:"chat.completion.chunk"})
    const terminal=events[2]!;const affinity={...terminal,choices:[{index:0,delta:{reasoning_opaque:carrier()},finish_reason:null}]}; delete (affinity as {usage?:unknown}).usage
    const wireEvents=[...events.slice(0,2),affinity,...events.slice(2)]
    const response=wireEvents.map(e=>`data: ${JSON.stringify(e)}\n\n`).join("")+"data: [DONE]\n\n"
    row.stream=true; row.wireEvidence.responseHeaders=[["content-type","text/event-stream"]]; f.storage.rows[0]!.response_headers_json=JSON.stringify(row.wireEvidence.responseHeaders); row.wireDone=true; row.wireEvents=wireEvents as never; row.responseBytes=Buffer.byteLength(response); row.responseSha256=sha(response)
    row.wireEvidence.response=response; row.wireEvidence.parsedEvents=wireEvents as never; row.wireEvidence.done=true
    row.wireEvidence.requestBody=row.wireEvidence.requestBody.replace('"stream":false','"stream":true'); row.requestSha256=sha(row.wireEvidence.requestBody); row.wireBytes=Buffer.byteLength(row.wireEvidence.requestBody)
    dispatch.requestedStream=true; dispatch.bodyBytes=row.wireBytes; dispatch.requestSha256=row.requestSha256; dispatch.responseBytes=row.responseBytes; dispatch.responseSha256=row.responseSha256
    f.storage.rows[0]!.meta.requestBytes=row.wireBytes; f.storage.rows[0]!.meta.responseBytes=row.responseBytes
    f.envelope.capture.response.body.data=response; f.envelope.capture.exchanges[0]!.request.body.data=row.wireEvidence.requestBody; f.envelope.capture.exchanges[0]!.response.body.data=response; f.envelope.capture.exchanges[0]!.response.complete=false
    const frames=events.map((e,i)=>({ts:i,frame:{type:"event",event:e}})); const stored=[...frames,{ts:3,frame:{type:"done"}}]
    const update=(index:number,raw:string)=>{const o=f.storage.objects[index]!; o.decodedBytes=Buffer.byteLength(raw);o.decodedSha256=sha(raw);o.decodedBase64=Buffer.from(raw).toString("base64")}
    f.storage.rows[0]!.response_body_descriptor.type="events"; f.storage.objects[1]!.type="events";f.storage.objects[1]!.owner.type="events"
    update(0,row.wireEvidence.requestBody);update(1,JSON.stringify(stored));update(2,JSON.stringify(f.envelope));f.storage.decodedBytes=f.storage.objects.reduce((n,o)=>n+o.decodedBytes,0)
    expect(verifyReferenceReadback(f.storage,f.rows,f.dispatches).records[0]!.classification).toBe("canonical_pre_affinity_semantics")
    update(1,JSON.stringify([...frames,{ts:3,frame:{type:"done"}},{ts:4,frame:{type:"done"}}]));f.storage.decodedBytes=f.storage.objects.reduce((n,o)=>n+o.decodedBytes,0)
    expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow()
  })

  test("rejects malformed SQL headers and changed application headers", () => {
    const f=fixture(); f.storage.rows[0]!.request_headers_json='[["authorization",7]]'
    expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow()
    f.storage.rows[0]!.request_headers_json="[]"
    expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow()
    f.storage.rows[0]!.request_headers_json=JSON.stringify([["authorization","Bearer wrong"],["content-type","application/json"]])
    expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow()
  })
  test("rejects SQL response media type and inconsistent hydrated upstream", () => {
    const f=fixture(); f.storage.rows[0]!.response_headers_json='[["content-type","text/event-stream"]]'
    expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow()
    f.storage.rows[0]!.response_headers_json=JSON.stringify(f.rows[0]!.wireEvidence.responseHeaders)
    Object.assign(f.storage.rows[0]!.meta,{upstream:{id:"wrong"}})
    expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow()
  })

})

test("native record association rejects a wrong benchmark header",()=>{const f=fixture();f.storage.rows[0]!.request_headers_json=JSON.stringify([["authorization","Bearer independent-fixture-key"],["content-type","application/json"],["x-benchmark-id","other"]]);expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow()})

test("pre-affinity comparator accepts exactly one authenticated carrier before stop", async()=>{
  const { verifyReferenceAffinityFidelity }=await import("./reference-oracle")
  expect(typeof verifyReferenceAffinityFidelity).toBe("function")
  const terminal={id:"chatcmpl_one",object:"chat.completion.chunk",created:1,model:"bench-chat-ok",choices:[{index:0,delta:{},finish_reason:"stop"}]}
  const good={...terminal,choices:[{index:0,delta:{reasoning_opaque:carrier()},finish_reason:null}]}
  expect(verifyReferenceAffinityFidelity([terminal],[good,terminal],"independent-fixture-key",true)).toBe("canonical_pre_affinity_semantics")
  expect(()=>verifyReferenceAffinityFidelity([terminal],[terminal],"independent-fixture-key",true)).toThrow()
  expect(()=>verifyReferenceAffinityFidelity([terminal],[terminal,good],"independent-fixture-key",true)).toThrow()
  expect(()=>verifyReferenceAffinityFidelity([terminal],[good,good,terminal],"independent-fixture-key",true)).toThrow()
  expect(()=>verifyReferenceAffinityFidelity([terminal],[{...good,usage:{total_tokens:10}},terminal],"independent-fixture-key",true)).toThrow()
  expect(()=>verifyReferenceAffinityFidelity([terminal],[good,{...terminal,choices:[{index:0,delta:{role:"user"},finish_reason:"stop"}]}],"independent-fixture-key",true)).toThrow()
  const invalid={...terminal,choices:[{index:0,delta:{reasoning_opaque:"not-native"},finish_reason:null}]}
  expect(()=>verifyReferenceAffinityFidelity([terminal],[invalid,terminal],"independent-fixture-key")).toThrow()
})

test("dump-disabled native JSON still authenticates its always-on carrier",()=>{
  const f=fixture();Object.assign(f.rows[0]!,{dump:false});f.storage.rows=[];f.storage.files=[];f.storage.objects=[];f.storage.compressedBytes=0;f.storage.decodedBytes=0
  expect(verifyReferenceReadback(f.storage,f.rows,f.dispatches).passed).toBe(true)
  for(const value of [undefined,"bad-carrier"]) {
    const wire=JSON.parse(f.rows[0]!.wireEvidence.response);if(value===undefined)delete wire.choices[0].message.reasoning_opaque;else wire.choices[0].message.reasoning_opaque=value
    f.rows[0]!.wireEvidence.response=JSON.stringify(wire);f.rows[0]!.wireEvidence.parsedEvents=[wire];f.rows[0]!.wireEvents=[wire];f.rows[0]!.responseBytes=Buffer.byteLength(f.rows[0]!.wireEvidence.response);f.rows[0]!.responseSha256=sha(f.rows[0]!.wireEvidence.response)
    expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow()
  }
})

test("dump-disabled SSE rejects absent or malformed always-on carrier",()=>{
  const f=fixture(),row=f.rows[0]!;Object.assign(row,{dump:false,stream:true});f.storage.rows=[];f.storage.files=[];f.storage.objects=[];f.storage.compressedBytes=0;f.storage.decodedBytes=0
  row.wireEvidence.requestBody=row.wireEvidence.requestBody.replace('"stream":false','"stream":true');row.requestSha256=sha(row.wireEvidence.requestBody);row.wireBytes=Buffer.byteLength(row.wireEvidence.requestBody);row.wireEvidence.responseHeaders=[["content-type","text/event-stream"]]
  const base={id:event.id,object:"chat.completion.chunk",created:event.created,model:event.model}
  const start={...base,choices:[{index:0,delta:{role:"assistant",content:"BENCH_OK:65536"},finish_reason:null}]},stop={...base,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:event.usage}
  for(const opaque of [carrier(),undefined,"bad"]) {
    const events=opaque===undefined?[start,stop]:[start,{...base,choices:[{index:0,delta:{reasoning_opaque:opaque},finish_reason:null}]},stop]
    row.wireEvidence.response=events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join("")+"data: [DONE]\n\n";row.wireEvidence.parsedEvents=events as never;row.wireEvents=events as never;row.wireDone=true;row.wireEvidence.done=true;row.responseBytes=Buffer.byteLength(row.wireEvidence.response);row.responseSha256=sha(row.wireEvidence.response)
    if(opaque===undefined || opaque==="bad") expect(()=>verifyReferenceReadback(f.storage,f.rows,f.dispatches)).toThrow()
    else expect(verifyReferenceReadback(f.storage,f.rows,f.dispatches).passed).toBe(true)
  }
})
