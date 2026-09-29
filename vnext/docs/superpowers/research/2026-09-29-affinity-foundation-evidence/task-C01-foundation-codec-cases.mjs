export async function runCodecCases({AffinityCodec,AFFINITY_MARKER,MAX_AFFINITY_WIRE_CHARS}) {
 const check=(condition,label)=>{if(!condition)throw new Error(label)}
 const settings={ownerId:'synthetic-owner',apiKeyId:'synthetic-api-key',version:1,keyId:'synthetic-key-id',secret:new Uint8Array(32).fill(19)}
 const codec=new AffinityCodec(settings),field={domain:'responses/reasoning/encrypted_content',block:'complete synthetic thinking\ud800'}
 const target={provider:'synthetic-provider',upstreamId:'synthetic-upstream',upstreamIncarnation:'synthetic-incarnation',credentialSubject:'synthetic-subject',credentialRevision:'synthetic-revision',model:'synthetic-raw-model'}
 let allUnits='';for(let start=0;start<65536;start+=8192)allUnits+=String.fromCharCode(...Array.from({length:8192},(_,index)=>start+index))
 const values=[allUnits,'','中文\ud800\udfff\ufeff\u0000','AAECA/8=','AAECA_8']
 for(const value of values){const wire=await codec.encode(value,target,field),read=await codec.decode(wire,field);check(read.kind==='owned'&&read.value===value,'Opaque code unit roundtrip');check(JSON.stringify(read.target)===JSON.stringify(target),'Target roundtrip');check(!wire.includes('synthetic-upstream'),'Plaintext metadata leak')}
 const rejected=async promise=>{try{await promise}catch(error){check(error?.code==='invalid_affinity_state','Unclassified carrier error');return}throw new Error('Accepted invalid authenticated carrier')}
 const wire=await codec.encode('opaque plaintext\ud800',target,field)
 await rejected(new AffinityCodec({...settings,secret:new Uint8Array(32).fill(20)}).decode(wire,field))
 await rejected(new AffinityCodec({...settings,ownerId:'other-owner'}).decode(wire,field))
 await rejected(new AffinityCodec({...settings,apiKeyId:'other-key'}).decode(wire,field))
 await rejected(codec.decode(wire,{...field,domain:'responses/compaction/encrypted_content'}))
 await rejected(codec.decode(wire,{...field,block:'swapped thinking'}))
 const offset=AFFINITY_MARKER.length+2;await rejected(codec.decode(wire.slice(0,offset)+(wire[offset]==='A'?'B':'A')+wire.slice(offset+1),field))
 for(const invalid of [AFFINITY_MARKER,`${AFFINITY_MARKER}9:${wire.slice(offset)}`,wire.slice(0,-3),`${AFFINITY_MARKER}1:${'A'.repeat(MAX_AFFINITY_WIRE_CHARS)}`])await rejected(codec.decode(invalid,field))
 for(const foreign of ['foreign\ud800','AAECA/8=','vnext-affinity-like']){const result=await codec.decode(foreign,field);check(result.kind==='foreign'&&result.value===foreign,'Foreign opaque changed')}
 return {allUtf16CodeUnits:65536,roundtripCases:values.length,authenticatedBindings:true,malformedAndOversizedRejected:true,foreignUnchanged:true,metadataEncrypted:true}
}
