import assert from "node:assert/strict"
import { createFixture } from "./workerd-fixture.mjs"
const f = await createFixture({ directNetwork: false })
try {
  const token = "ses_c12_capability_synthetic"
  const now = new Date().toISOString()
  await f.db.prepare("INSERT INTO user_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)").bind(token,"c12-f4-owner",now,new Date(Date.now()+3600000).toISOString()).run()
  const headers = { authorization: `Bearer ${token}` }
  const read = async bare => {
    const response = await fetch(`${f.gatewayBase}/api/capabilities`, { headers: { ...headers, ...(bare ? {"x-c12-bare":"true"} : {}) } })
    assert.equal(response.status,200)
    assert.match(response.headers.get("cache-control") ?? "",/no-store/)
    const body = await response.json()
    assert.deepEqual(body.codex.responsesWebSocket,{available:!bare,mode:"single_turn",multiplex:false,fork:false,reconnectHistory:false,maxConnectionOutboundBytes:bare?null:16777216})
    return body
  }
  const before = await f.db.prepare("SELECT revision FROM configuration_revision WHERE id=1").first()
  const values = await Promise.all([read(false),read(true),read(false),read(true)])
  assert.deepEqual(await f.db.prepare("SELECT revision FROM configuration_revision WHERE id=1").first(),before)
  const denied = await fetch(`${f.gatewayBase}/api/capabilities`)
  assert([401,403].includes(denied.status))
  assert.equal((await f.observe()).upstream_requests.length,0)
  await f.db.prepare("UPDATE upstreams SET config_json=? WHERE id='custom:c12-loopback'").bind(JSON.stringify({name:"C12 loopback",baseUrl:`${f.fixtureBase}/v1`,authStyle:"none",endpoints:["responses"],models:["gpt-5.6-sol","gpt-capability-unmatched-2026"]})).run()
  for (const bare of [false,true]) {
    const response = await fetch(`${f.gatewayBase}/models`,{headers:{authorization:`Bearer ${f.key}`,"user-agent":"codex-tui/0.144.1",...(bare?{"x-c12-bare":"true"}:{})}})
    assert.equal(response.status,200)
    const body = await response.json()
    for (const slug of ["gpt-5.6-sol","gpt-capability-unmatched-2026"]) {
      const model = body.models.find(row=>row.slug===slug)
      assert(model,slug)
      assert.equal(model.prefer_websockets,!bare)
    }
  }
  console.log(JSON.stringify({passed:true,runtime:"workerd 2025-06-01 nodejs_compat D1",native:values[0],bare:values[1],concurrentRequests:4,capabilityUpstreamCalls:0,capabilityRevisionUnchanged:true,catalogMatchedAndUnmatched:true}))
} finally { await f.stop() }
