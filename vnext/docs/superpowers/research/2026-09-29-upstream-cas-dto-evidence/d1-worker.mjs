import { D1Repo } from '__ROOT__/vnext/apps/platform-cloudflare/src/d1-repo.ts'
const assert=(condition,message)=>{if(!condition)throw new Error(message)}
const equal=(a,b,message)=>assert(JSON.stringify(a)===JSON.stringify(b),message)
const fixture=(id,state={access:'old',quota:1})=>({id,ownerId:'fixture-owner',provider:'custom',name:'before',enabled:true,sortOrder:0,config:{baseUrl:'https://example.invalid',apiKey:'synthetic'},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[],state,createdAt:'2026-09-29T00:00:00.000Z',updatedAt:'2026-09-29T00:00:00.000Z'})
function interceptReads(db,hook){
 const wrap=(statement,sql,values=[])=>({
  bind(...next){return wrap(statement.bind(...next),sql,next)},
  async first(...args){const row=await statement.first(...args);if(/^\s*SELECT\b/i.test(sql)&&/FROM upstreams\b/i.test(sql))await hook(sql,values,row);return row},
  all(...args){return statement.all(...args)},run(...args){return statement.run(...args)},
 })
 return{prepare(sql){return wrap(db.prepare(sql),sql)},batch(statements){return db.batch(statements)}}
}
async function errorName(promise){try{await promise;return 'NO_ERROR'}catch(error){return error.name}}
export default{async fetch(_request,env){try{
 const db=env.DB,repo=new D1Repo(db),results={}
 const legacy=await repo.upstreams.getById('legacy');equal(legacy.state,{credential:'synthetic-preserved'},'Migration changed legacy state');equal(legacy.config,{safe:true},'Migration changed legacy config');assert(/^[a-f0-9]{32}$/.test(legacy.rowIncarnation),'Legacy incarnation absent');results.legacyPreserved=true
 await repo.upstreams.save(fixture('replay'))
 let hookRuns=0,updates=0
 const raced=new D1Repo(interceptReads(db,async()=>{if(hookRuns++===0)await repo.upstreams.saveState('replay',state=>({...state,quota:9}))}))
 await raced.upstreams.saveState('replay',state=>{updates++;return{...state,access:'rotated'}})
 equal((await repo.upstreams.getById('replay')).state,{access:'rotated',quota:9},'CAS lost concurrent quota');assert(updates===2,'CAS must replay once');results.stateReplay=updates
 await repo.upstreams.save(fixture('nullable',null));await repo.upstreams.saveState('nullable',()=>({ready:true}));equal((await repo.upstreams.getById('nullable')).state,{ready:true},'NULL CAS failed')
 const before=await db.prepare('SELECT revision FROM configuration_revision WHERE id=1').first('revision')
 await repo.upstreams.saveState('nullable',state=>state)
 const after=await db.prepare('SELECT revision FROM configuration_revision WHERE id=1').first('revision');assert(before===after,'No-op wrote row');results.nullAndNoOp=true
 for(const unchanged of [false,true]){
  const id=unchanged?'aba-noop':'aba-write';await repo.upstreams.save(fixture(id));const original=await repo.upstreams.getById(id);let once=false
  const stale=new D1Repo(interceptReads(db,async()=>{if(!once){once=true;await repo.upstreams.delete(id);await repo.upstreams.save(fixture(id))}}))
  const name=await errorName(stale.upstreams.saveState(id,state=>unchanged?state:{...state,access:'wrong'}));assert(name==='UpstreamReplacedError',`ABA ${unchanged}: ${name}`)
  const replacement=await repo.upstreams.getById(id);assert(replacement.rowIncarnation!==original.rowIncarnation,'ABA incarnation reused');equal(replacement.state,original.state,'ABA overwrote state');assert(replacement.createdAt===original.createdAt,'Fixture timestamps differ')
  results[id]=name
 }
 results.missing=await errorName(repo.upstreams.saveState('absent',()=>({})));assert(results.missing==='UpstreamGoneError','Missing row not gone')
 await repo.upstreams.save(fixture('contention'));let wins=0,mutations=0
 const contended=new D1Repo(interceptReads(db,async()=>{await db.prepare('UPDATE upstreams SET state_json=? WHERE id=?').bind(JSON.stringify({winner:++wins}),'contention').run()}))
 results.contention=await errorName(contended.upstreams.saveState('contention',()=>{mutations++;return{loser:true}}));assert(results.contention==='UpstreamContentionError','Contention not bounded');assert(mutations>1&&mutations<=10,'Unexpected retry count');equal((await repo.upstreams.getById('contention')).state,{winner:wins},'Contention overwrote winner');results.contentionMutations=mutations
 await repo.upstreams.save(fixture('metadata'));const target=await repo.upstreams.getById('metadata');let once=false,patches=0
 const metaRepo=new D1Repo(interceptReads(db,async()=>{if(!once){once=true;await db.prepare('UPDATE upstreams SET name=?,state_json=? WHERE id=?').bind('sibling','{"quota":22}','metadata').run()}}))
 const saved=await metaRepo.upstreams.patchMetadata(target,current=>{patches++;return{...current,enabled:false}})
 assert(saved.name==='sibling'&&!saved.enabled,'Metadata lost sibling patch');equal(saved.state,{quota:22},'Metadata lost private state');assert(patches===2,'Metadata must rebase once');results.metadataRebases=patches
 await db.prepare('UPDATE upstreams SET owner_id=? WHERE id=?').bind('other-owner','metadata').run()
 results.staleOwner=await errorName(repo.upstreams.patchMetadata(saved,current=>({...current,name:'wrong'})));assert(results.staleOwner==='UpstreamReplacedError','Metadata owner fence failed')
 results.staleStateOwner=await errorName(repo.upstreams.saveState('metadata',()=>({wrong:true}),saved));assert(results.staleStateOwner==='UpstreamReplacedError','State expected owner fence failed')
 const created=await repo.upstreams.createIfAbsent(fixture('first-login'));assert(/^[a-f0-9]{32}$/.test(created.rowIncarnation),'Explicit INSERT lacks incarnation');assert(await repo.upstreams.createIfAbsent({...fixture('first-login'),ownerId:'attacker'})===null,'createIfAbsent overwrote existing');results.insertIfAbsent=true
 await db.prepare("INSERT INTO upstreams(id,provider,name,created_at,updated_at)VALUES('raw','custom','raw','same','same')").run();const raw=await repo.upstreams.getById('raw');assert(/^[a-f0-9]{32}$/.test(raw.rowIncarnation),'Raw INSERT fallback missing')
 let rejected=false;try{await db.prepare("UPDATE upstreams SET row_incarnation='changed' WHERE id='raw'").run()}catch{rejected=true}assert(rejected,'Incarnation mutable');results.rawInsertAndImmutable=true
 await repo.upstreams.save({...fixture('first-login'),state:{imported:true}});const imported=await repo.upstreams.getById('first-login');assert(imported.rowIncarnation===created.rowIncarnation,'Replacement changed row incarnation');equal(imported.state,{imported:true},'Explicit replacement not honored');results.explicitReplacement=true
 return Response.json({passed:true,results})
}catch(error){return Response.json({passed:false,error:{name:error.name,message:error.message,stack:error.stack}},{status:500})}}}
