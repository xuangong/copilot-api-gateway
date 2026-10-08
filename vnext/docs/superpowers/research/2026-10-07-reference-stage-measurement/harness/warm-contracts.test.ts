import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { makeRequest, cells } from "./contracts"
import { aggregateWarmRun, freezeWarmPlan, requestIdentity, type WarmWindowEvidence } from "./warm-contracts"
function complete() {
  const plan=freezeWarmPlan({runId:"test"})
  const windows: WarmWindowEvidence[]=plan.windows.map(w=>{
    const rows=(["warmup","timed"] as const).flatMap(phase=>Array.from({length:phase==="warmup"?w.warmup:w.timed},(_,ordinal)=>({id:requestIdentity(w.id,phase,ordinal),arm:w.arm,phase,cell:w.cell.id,dump:w.cell.dump,stream:w.cell.stream,wireBytes:w.cell.bytes,requestSha256:"mock-complete-request-hash",status:200,ok:true,eofMs:20,dumpRecordId:w.cell.dump && w.arm!=="R"?`${w.id}-${phase}-${ordinal}`:null,wireEvidence:"independent.json"})))
    const start={pid:42,startIdentity:"darwin-abstime:1",executableName:"workerd",scope:"darwin-process-libproc-rusage-v2",observedAtMs:1,userUs:10,systemUs:5,rssBytes:100}
    const end={...start,observedAtMs:100,userUs:2010,systemUs:1005,rssBytes:200}
    return {id:w.id,block:w.block,arm:w.arm,cell:w.cell.id,identity:{hooks:false,inspector:null},observations:{rows,dispatches:rows.map(r=>({id:r.id,status:200,completed:true,cancelled:false,requestedStream:w.arm==="R"||w.cell.stream})),processStart:start,processEnd:end,resources:{pid:42,startIdentity:start.startIdentity,scope:start.scope,elapsedMs:99,userUs:2000,systemUs:1000,cpuUs:3000},warmupSettlement:{active:0,pending:0,registered:5,settled:5,failures:[],observerFailures:0,unowned:0},settlement:{active:0,pending:0,registered:25,settled:25,failures:[],observerFailures:0,unowned:0},scope:"warmed-no-inspector-through-settlement"},readback:{semantic:{passed:true,historyDisabled:true,records:w.cell.dump && w.arm==="R"?rows.map(r=>({logicalId:r.id,recordId:`native-${r.id}`,passed:true,correlation:{basis:"sql-benchmark-header-and-full-request-bytes",benchmarkId:r.id,requestSha256:r.requestSha256,requestBytes:r.wireBytes}})):[]}},completed:true}
  })
  return {plan,windows}
}
test("fixed balanced exploratory plan and complete aggregation",()=>{const {plan,windows}=complete();expect(plan.windows.length).toBe(108);const a=aggregateWarmRun(plan,windows);expect(a.comparisonQualified).toBe(true);expect(a.totals.timedOffered).toBe(2160);expect(a.groups.length).toBe(18);expect(a.groups[0]!.blocks.length).toBe(6)})
test("missing window cannot silently rebalance",()=>{const f=complete();f.windows.pop();expect(aggregateWarmRun(f.plan,f.windows).comparisonQualified).toBe(false)})
test("rejects Inspector, process reuse, wrong CPU delta, and source format",()=>{for(const mutate of [(w:WarmWindowEvidence)=>{w.identity.inspector={}},(w:WarmWindowEvidence)=>{w.observations.processEnd={...w.observations.processEnd,pid:43}},(w:WarmWindowEvidence)=>{w.observations.resources={...w.observations.resources,cpuUs:1}},(w:WarmWindowEvidence)=>{w.observations.dispatches[0]!.requestedStream=!w.observations.dispatches[0]!.requestedStream}]){const f=complete();mutate(f.windows[0]!);expect(aggregateWarmRun(f.plan,f.windows).comparisonQualified).toBe(false)}})
test("rejects phase identity drift and dump-disabled IDs",()=>{const f=complete();f.windows[0]!.observations.rows[0]!.phase="timed";expect(aggregateWarmRun(f.plan,f.windows).comparisonQualified).toBe(false);const g=complete();g.windows.find(w=>!g.plan.windows.find(p=>p.id===w.id)!.cell.dump)!.observations.rows[0]!.dumpRecordId="unexpected";expect(aggregateWarmRun(g.plan,g.windows).comparisonQualified).toBe(false)})
test("failed requests stay in offered CPU numerator and success denominator",()=>{const f=complete();const w=f.windows[0]!;w.observations.rows.filter(r=>r.phase==="timed").forEach(r=>{r.ok=false});const a=aggregateWarmRun(f.plan,f.windows);expect(a.comparisonQualified).toBe(false);const b=a.groups.find(g=>g.arm===w.arm && g.cell===w.cell)!.blocks[0]!;expect(b.cpuPerOfferedMs).toBe(0.15);expect(b.cpuPerSuccessMs).toBe(null);expect(b.offered).toBe(20)})
test("readback false or unfinished settlement prevents qualification",()=>{const f=complete();f.windows[0]!.readback.semantic!.passed=false;expect(aggregateWarmRun(f.plan,f.windows).comparisonQualified).toBe(false);const g=complete();g.windows[0]!.observations.settlement.pending=1;expect(aggregateWarmRun(g.plan,g.windows).comparisonQualified).toBe(false)})

test("rejects duplicate/extra windows and duplicate request ids",()=>{const f=complete();f.windows.push(f.windows[0]!);expect(aggregateWarmRun(f.plan,f.windows).comparisonQualified).toBe(false);const g=complete();g.windows[0]!.observations.rows[1]!.id=g.windows[0]!.observations.rows[0]!.id;expect(aggregateWarmRun(g.plan,g.windows).comparisonQualified).toBe(false)})
test("rejects mutated plan and negative latency while preserving the expected plan",()=>{const f=complete();f.plan.expectedTimed=1;expect(()=>aggregateWarmRun(f.plan,f.windows)).toThrow();const g=complete();g.windows[0]!.observations.rows[5]!.eofMs=-1;expect(aggregateWarmRun(g.plan,g.windows).comparisonQualified).toBe(false)})

test("independent raw wire helper rejects tampered hashes and forged parsed semantics",async()=>{
  const { verifyWarmWireRows }=await import("./warm-contracts")
  expect(typeof verifyWarmWireRows).toBe("function")
  const row={id:"one",arm:"R" as const,phase:"timed",cell:"json-string-full",dump:true,status:200,ok:true,eofMs:20,dumpRecordId:"record",stream:false,requestSha256:"wrong",responseSha256:"wrong",wireBytes:1,responseBytes:1,wireEvents:[],wireDone:false,wireEvidence:{requestBody:"{}",response:"{}",parsedEvents:[],done:false,row:{id:"one"}}}
  expect(()=>verifyWarmWireRows([row])).toThrow()
})

test("raw wire helper validates valid bytes before detecting semantic tampering",async()=>{
  const {verifyWarmWireRows}=await import("./warm-contracts"),sha=(s:string)=>createHash("sha256").update(s).digest("hex")
  const requestBody=makeRequest("one",cells.find(c=>c.id==="json-string-full")!)
  const event={choices:[{index:0,message:{role:"assistant",content:"BENCH_OK:65536"},finish_reason:"stop"}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}
  const response=JSON.stringify(event)
  const row={id:"one",arm:"R" as const,phase:"timed",cell:"json-string-full",dump:true,status:200,ok:true,eofMs:20,dumpRecordId:"record",stream:false,requestSha256:sha(requestBody),responseSha256:sha(response),wireBytes:Buffer.byteLength(requestBody),responseBytes:Buffer.byteLength(response),wireEvents:[event],wireDone:false}
  const evidence={requestBody,response,parsedEvents:[event],done:false,row:{...row}}
  expect(verifyWarmWireRows([{...row,wireEvidence:evidence}]).checkedRows).toBe(1)
  event.choices[0]!.message.content="wrong";evidence.response=JSON.stringify(event);row.responseSha256=sha(evidence.response);row.responseBytes=Buffer.byteLength(evidence.response);evidence.row={...row}
  expect(()=>verifyWarmWireRows([{...row,wireEvidence:evidence}])).toThrow()
})
test("incomplete warmup settlement and regressing terminal counters cancel qualification",()=>{const f=complete();f.windows[0]!.observations.warmupSettlement.pending=1;expect(aggregateWarmRun(f.plan,f.windows).comparisonQualified).toBe(false);const g=complete();g.windows[0]!.observations.settlement.registered=1;g.windows[0]!.observations.settlement.settled=1;expect(aggregateWarmRun(g.plan,g.windows).comparisonQualified).toBe(false)})

test("aggregate rejects downstream stream and request byte count drift",()=>{const f=complete();f.windows[0]!.observations.rows[0]!.stream=!f.windows[0]!.observations.rows[0]!.stream;expect(aggregateWarmRun(f.plan,f.windows).comparisonQualified).toBe(false);const g=complete();g.windows[0]!.observations.rows[0]!.wireBytes=100;expect(aggregateWarmRun(g.plan,g.windows).comparisonQualified).toBe(false)})
test("raw wire helper rejects self-consistent wrong request size or container shape",async()=>{
  const {verifyWarmWireRows}=await import("./warm-contracts"),sha=(s:string)=>createHash("sha256").update(s).digest("hex")
  const event={choices:[{index:0,message:{role:"assistant",content:"BENCH_OK:65536"},finish_reason:"stop"}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}},response=JSON.stringify(event)
  for(const requestBody of [JSON.stringify({stream:false,model:"bench-chat-ok",messages:[{role:"user",content:"BENCH_ID:one"}]}),makeRequest("one",cells.find(c=>c.id==="json-containers-full")!)]) {
    const row={id:"one",arm:"R" as const,phase:"timed",cell:"json-string-full",dump:true,status:200,ok:true,eofMs:20,dumpRecordId:"record",stream:false,requestSha256:sha(requestBody),responseSha256:sha(response),wireBytes:Buffer.byteLength(requestBody),responseBytes:Buffer.byteLength(response),wireEvents:[event],wireDone:false}
    const evidence={requestBody,response,parsedEvents:[event],done:false,row:{...row}}
    expect(()=>verifyWarmWireRows([{...row,wireEvidence:evidence}])).toThrow()
  }
})

test("R dump-on requires native readback association while wire header stays null",()=>{const f=complete(),r=f.windows.find(w=>w.arm==="R" && f.plan.windows.find(p=>p.id===w.id)!.cell.dump)!;r.readback.semantic!.records!.pop();expect(aggregateWarmRun(f.plan,f.windows).comparisonQualified).toBe(false)})
