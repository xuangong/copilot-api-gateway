export async function runAnalysisCases({AffinityCodec},{analyzeAffinityRequest,stampAffinityItem}) {
 const check=(condition,label)=>{if(!condition)throw new Error(label)}
 const codec=new AffinityCodec({ownerId:'synthetic-owner',apiKeyId:'synthetic-api-key',version:1,keyId:'synthetic-key-id',secret:new Uint8Array(32).fill(19)})
 const exact={provider:'synthetic',upstreamId:'upstream',upstreamIncarnation:'incarnation',credentialSubject:'account',credentialRevision:'revision',model:'raw-a'}
 const other={...exact,model:'raw-b'},replaced={...exact,credentialRevision:'replacement'}
 const thinking={type:'thinking',thinking:'complete synthetic thought',signature:'opaque-sig\ud800'}
 const stamped=await stampAffinityItem('messages',thinking,exact,codec)
 const body={messages:[{role:'assistant',content:[stamped]},{role:'user',content:'continue'}]}
 const before=JSON.stringify(body),analysis=await analyzeAffinityRequest('messages',body,codec)
 check(analysis.classify(exact)==='exact'&&analysis.classify(other)==='degraded','Optional target matching')
 check(JSON.stringify(analysis.materialize(exact).messages[0].content[0])===JSON.stringify(thinking),'Whole thinking restoration')
 check(analysis.materialize(other).messages.length===1,'Empty assistant not removed')
 const one=analysis.materialize(exact);one.messages[0].content[0].thinking='mutated'
 check(analysis.materialize(exact).messages[0].content[0].thinking===thinking.thinking&&JSON.stringify(body)===before,'Candidate mutation leak')
 const tampered={messages:[{role:'assistant',content:[{...stamped,thinking:'swapped text'}]}]}
 try{await analyzeAffinityRequest('messages',tampered,codec);throw new Error('tamper accepted')}catch(error){check(error.code==='invalid_affinity_state','Thinking authentication failure not classified')}
 const requiredItem=await stampAffinityItem('responses',{type:'compaction',encrypted_content:'required-opaque'},exact,codec)
 const required=await analyzeAffinityRequest('responses',{input:[requiredItem]},codec)
 check(required.classify(exact)==='exact'&&required.classify(other)==='unavailable'&&required.classify(replaced)==='unavailable','Required exact credential matching')
 check(required.rankAuthorizedCandidates([other,exact],value=>value).length===1,'Unauthorized/incompatible candidate accepted')
 try{required.materialize(other);throw new Error('required mismatch accepted')}catch(error){check(error.code==='affinity_routing_unavailable','Required rejection not classified')}
 const aliased=await analyzeAffinityRequest('responses',{input:[{...requiredItem,type:'compaction_summary'}]},codec)
 check(aliased.materialize(exact).input[0].encrypted_content==='required-opaque','Compaction alias lost domain')
 const explicit={...exact,compatibility:{version:1,key:'explicit-fixture',scope:'owner'}}
 const compatible={...other,compatibility:explicit.compatibility}
 const compatibleItem=await stampAffinityItem('responses',{type:'reasoning',encrypted_content:'optional'},explicit,codec)
 const ranked=await analyzeAffinityRequest('responses',{input:[compatibleItem]},codec)
 const authorized=[replaced,compatible,explicit]
 check(ranked.rankAuthorizedCandidates(authorized,value=>value).map(value=>value.model).join(',')==='raw-a,raw-b,raw-a','Exact-compatible-degraded order')
 const foreign=await analyzeAffinityRequest('responses',{input:[{type:'compaction',encrypted_content:'foreign'}]},codec)
 check(foreign.materialize(other).input[0].encrypted_content==='foreign','Foreign payload modified')
 const raw=await analyzeAffinityRequest('messages',body)
 check(JSON.stringify(raw.materialize(other))===before,'No stable identity changed raw request')
 const toolBody={messages:[{role:'assistant',content:[stamped,{type:'tool_use',id:'tool',name:'test',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'tool',content:'ok'}]}]}
 check((await analyzeAffinityRequest('messages',toolBody,codec)).classify(other)==='unavailable','Unsafe tool-adjacent block degradation')
 return {wholeThinkingAuthenticated:true,optionalWholeBlockRemoval:true,requiredAndReplacementFenced:true,compactionAlias:true,immutableCandidates:true,rankedAuthorizedOnly:true,foreignAndIdentitylessPreserved:true,toolAdjacentRejected:true}
}
