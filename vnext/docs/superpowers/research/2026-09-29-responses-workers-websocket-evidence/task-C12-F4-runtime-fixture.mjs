import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const waitFor=async(predicate,ms,label)=>{
  const end=Date.now()+ms
  while(!predicate()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20))
  assert(predicate(),`${label} timed out`)
}

/** Real, isolated workerd/D1 plus a separate Node HTTP/SSE producer. */
export async function createFixture({preparationOnly=false,directNetwork=false}={}){
  const root=process.env.VNEXT_PROBE_ROOT
  assert(root&&root.startsWith('/'),'VNEXT_PROBE_ROOT must be an absolute checkout path')
  const workerPath=`${root}/vnext/apps/platform-cloudflare/src/worker.ts`
  const adapterPath=`${root}/vnext/apps/platform-cloudflare/src/responses-websocket.ts`
  assert(existsSync(workerPath),'production Worker entrypoint missing')
  if(!preparationOnly)assert(existsSync(adapterPath),'F4 production adapter missing; use preparationOnly for infrastructure smoke')
  const run=await mkdtemp(join(tmpdir(),'c12-f4-workerd-'))
  const entry=join(run,'worker-entry.ts'),bundle=join(run,'worker.mjs')
  const template=await readFile(new URL('./task-C12-F4-worker-entry.ts.txt',import.meta.url),'utf8')
  await writeFile(entry,template.replaceAll('__ROOT__',root))
  const build=spawnSync('bun',['build',entry,'--target=node','--external=cloudflare:sockets',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'})
  assert.equal(build.status,0,build.stderr||build.stdout)
  const nodeBinary=process.env.C12_NODE_BINARY??'/opt/homebrew/bin/node'
  assert(nodeBinary.startsWith('/')&&existsSync(nodeBinary),'absolute local Node binary required')
  const producer=spawn(nodeBinary,[new URL('./task-C12-F4-node-fixture.mjs',import.meta.url).pathname],{stdio:['ignore','pipe','inherit']})
  let stdout='',fixtureBase,mf,closing=false
  producer.stdout.on('data',chunk=>{
    stdout+=chunk.toString()
    let at
    while((at=stdout.indexOf('\n'))>=0){
      const parsed=JSON.parse(stdout.slice(0,at));stdout=stdout.slice(at+1)
      if(parsed.fixtureBase)fixtureBase=parsed.fixtureBase
    }
  })
  async function stop(){
    if(closing)return
    closing=true
    await mf?.dispose()
    if(producer.exitCode===null){
      const exited=new Promise(resolve=>producer.once('exit',resolve))
      producer.kill('SIGTERM')
      await exited
    }
  }
  try{
    await waitFor(()=>fixtureBase||producer.exitCode!==null,5000,'independent Node fixture startup')
    assert(fixtureBase&&/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(fixtureBase),'Node fixture must bind loopback')
    const {Miniflare}=await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
    const {unstable_splitSqlQuery}=await import(`${root}/vnext/node_modules/.bun/wrangler@4.97.0+01d2f64f02d20ae6/node_modules/wrangler/wrangler-dist/cli.js`)
    const fixtureUrl=new URL(fixtureBase)
    mf=new Miniflare({modules:true,modulesRoot:run,scriptPath:bundle,host:'127.0.0.1',port:0,
      compatibilityDate:'2025-06-01',compatibilityFlags:['nodejs_compat'],
      d1Databases:{DB:'c12-f4-local'},d1Persist:join(run,'d1'),
      kvNamespaces:['KV','IMAGE_CACHE'],images:{binding:'IMAGES'},r2Buckets:['FILES'],
      ...(!directNetwork?{outboundService:async request=>{
        const url=new URL(request.url)
        assert.equal(url.hostname,'127.0.0.1','external egress blocked in fixture')
        assert.equal(url.port,fixtureUrl.port,'unexpected loopback egress blocked')
        // Preserve the real Node response stream and its cancellation path.
        const controller=new AbortController()
        request.signal?.addEventListener('abort',()=>controller.abort(request.signal.reason),{once:true})
        const body=request.method==='GET'||request.method==='HEAD'?undefined:await request.arrayBuffer()
        return fetch(request.url,{method:request.method,headers:request.headers,body,signal:controller.signal})
      }}:{}),
    })
    const db=await mf.getD1Database('DB')
    const migrations=[]
    for(const file of(await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(name=>name.endsWith('.sql')).sort()){
      for(const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${file}`,'utf8')))await db.prepare(sql).run()
      migrations.push(file)
    }
    const now=new Date().toISOString(),key='sk_c12_local_fixture_only'
    await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind('c12-f4-owner','C12 synthetic','c12-f4@example.invalid',now).run()
    await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)').bind('c12-f4-key','C12 synthetic',key,now,'c12-f4-owner',0).run()
    await db.prepare('INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(
      'custom:c12-loopback','c12-f4-owner','custom','C12 loopback',JSON.stringify({name:'C12 loopback',baseUrl:`${fixtureBase}/v1`,authStyle:'none',endpoints:['responses'],models:['gpt-5.4']}),'[{"id":"direct_fetch"}]',now,now,
    ).run()
    const ready=await mf.ready
    assert.equal(ready.hostname,'127.0.0.1')
    const gatewayBase=`http://127.0.0.1:${ready.port}`
    const configured=await fetch(`${fixtureBase}/__fixture/config-gateway`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({gatewayBase})})
    assert.equal(configured.status,200,await configured.text())
    const initial=await(await fetch(`${fixtureBase}/__fixture/c12`)).json()
    assert.equal(initial.schema_version,1)
    assert.deepEqual(initial.connections,[])
    assert.deepEqual(initial.upstream_requests,[])
    assert.equal(initial.http_posts,0)
    return {root,run,mf,db,gatewayBase,fixtureBase,key,migrations,preparationOnly,directNetwork,producer,stop,
      observe:async({summary=false}={})=>{
        const response=await fetch(`${fixtureBase}/__fixture/c12${summary?'?summary=1':''}`)
        assert.equal(response.status,200)
        return response.json()
      },
      async releaseHeld(){const response=await fetch(`${fixtureBase}/__fixture/release`,{method:'POST'});assert.equal(response.status,200);return response.json()},
    }
  }catch(error){await stop();throw error}
}
