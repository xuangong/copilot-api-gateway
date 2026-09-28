import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { app } from "../src/app"
import { initRepo } from "../src/repo/index"
import type { ApiKeyId, SessionToken, UserId } from "../src/repo/branded-ids"
import type { UsageRecord, User, UserSession, ApiKey } from "../src/repo/types"
import type { UsageOverview, UsageOverviewQuery } from "../src/repo/usage-overview"
import { aggregateUsageForDisplay } from "../src/control-plane/token-usage/aggregate"
import { adaptUsageRow } from "../../../apps/dashboard/src/api/usage"
import { sharedKeyRef } from "../src/control-plane/lib/redact-shared-view"

// Branded IDs enter at this synthetic fixture boundary.
const keyId = (s: string): ApiKeyId => s as ApiKeyId
const userId = (s: string): UserId => s as UserId
const token = (s: string): SessionToken => s as SessionToken
const range: UsageOverviewQuery = { start: "2026-09-01T00", end: "2026-09-02T00", bucket: "hour", axis: "key" }
const record = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  keyId: keyId("a"), incomingModel: "alias", model: "model", modelKey: "price", upstream: null,
  client: "client", hour: range.start, requests: 2,
  tokens: { input: 100, output: 9, input_cache_read: 30, input_cache_write: 4, input_image: 2, output_image: 3 },
  cost: { input: 0.125, output: 0.00000003125 }, ...over,
})

test("overview matches the real detail adapter with historical price identities and bounded pages", async () => {
  const db = new Database(":memory:")
  try {
    const repo = new BunSqliteRepo(db)
    await repo.usage.record(record())
    await repo.usage.record(record({ upstream: "other", modelKey: "p2", cost: { input: 9.125, output: 0 } }))
    await repo.usage.record(record({ keyId: keyId("b"), incomingModel: "", cost: {} }))
    await repo.usage.record(record({ keyId: keyId("c"), tokens: {}, requests: 7 }))
    await repo.usage.record(record({ keyId: keyId("d"), incomingModel: "a\0b", model: "c" }))
    await repo.usage.record(record({ keyId: keyId("d"), incomingModel: "a", model: "b\0c" }))
    await repo.usage.record(record({ keyId: keyId("end"), hour: range.end }))
    // Imported historical rows retain null snapshots and explicit zero prices.
    db.run("UPDATE usage SET unit_price=NULL WHERE dimension IN ('input_cache_read','input_cache_write','input_image','output_image')")
    db.run("UPDATE usage SET unit_price=0 WHERE key_id='a' AND dimension='input_cache_write'")
    db.run("DELETE FROM usage_requests WHERE key_id='d'")
    db.run("UPDATE usage SET tokens=-50 WHERE key_id='a' AND upstream='other' AND dimension='input'")
    db.run("INSERT INTO usage (key_id,incoming_model,model,upstream,model_key,client,hour,dimension,tokens,unit_price) VALUES ('unknown','','model',NULL,'price','','2026-09-01T00','future',999,99)")
    db.run("INSERT INTO usage (key_id,incoming_model,model,upstream,model_key,client,hour,dimension,tokens,unit_price) VALUES ('observed-zero','','model',NULL,'price','','2026-09-01T00','input',0,NULL)")
    const detail = aggregateUsageForDisplay(await repo.usage.query({start: range.start, end: range.end})).map(adaptUsageRow)
    const overview = await repo.usage.queryOverview({ ...range, limit: 1 })
    const expected = detail.reduce((a,r) => ({ requests:a.requests+r.requests,input:a.input+r.inputTokens,output:a.output+r.outputTokens,
      cacheRead:a.cacheRead+(r.cacheReadTokens??0),cacheCreation:a.cacheCreation+(r.cacheCreationTokens??0),costUSD:a.costUSD+(r.cost?.totalUSD??0) }),
      {requests:0,input:0,output:0,cacheRead:0,cacheCreation:0,costUSD:0})
    for (const k of ["requests","input","output","cacheRead","cacheCreation"] as const) expect(overview.total[k]).toBe(expected[k])
    expect(Math.abs(overview.total.costUSD-expected.costUSD)).toBeLessThanOrEqual(Math.max(1e-12, Math.abs(expected.costUSD)*1e-10))
    expect(overview.total.unpricedTokens).toBe(148)
    expect(overview.total.observedDimensions).toHaveLength(6)
    expect(overview.breakdown.hasMore).toBe(true)
    const values: string[] = []
    let cursor: string | undefined
    do {
      const page = await repo.usage.queryOverview({ ...range, limit: 1, cursor })
      expect(page.total).toEqual(overview.total)
      values.push(...page.breakdown.rows.map(r => r.value))
      cursor = page.breakdown.nextCursor ?? undefined
    } while (cursor !== undefined)
    expect(values).toEqual(["a","b","c","d","observed-zero","unknown"])
    expect(overview.buckets).toHaveLength(1)
    const empty = await repo.usage.queryOverview({ ...range, keyIds: [] })
    expect(empty.total.hasRecords).toBe(false)
    expect(empty.buckets).toEqual([])
    expect((await repo.usage.queryOverview({ ...range, keyIds: [keyId("a")], keyId: keyId("b") })).total.hasRecords).toBe(false)
    const large = Array.from({length: 3000}, (_,i) => keyId(`missing${i}`))
    expect((await repo.usage.queryOverview({ ...range, keyIds: [...large,keyId("a")] })).total.requests).toBe(4)
    expect((await repo.usage.queryOverview({ ...range, incomingModel: "" })).total.unpricedTokens).toBe(148)
    expect((await repo.usage.queryOverview({ ...range, client: "absent" })).total.hasRecords).toBe(false)
    expect((await repo.usage.queryOverview({ ...range, model: "c", incomingModel: "a\0b" })).total.requests).toBe(0)
    expect((await repo.usage.queryOverview({ ...range, keyId: keyId("observed-zero") })).total.observedDimensions).toEqual(["input"])
    expect((await repo.usage.queryOverview({ ...range, keyId: keyId("c") })).total.observedDimensions).toEqual([])
  } finally { db.close() }
})

test("overview rejects invalid ranges, excessive buckets, axes and pages at repository boundary", async () => {
  const db = new Database(":memory:")
  try {
    const repo = new BunSqliteRepo(db)
    for (const over of [{start:"2026-02-30T00"},{end:range.start},{end:"2026-10-03T00"},{cursor:"-1"},{cursor:"1e3"},{limit:201},{limit:1.5}] satisfies Partial<UsageOverviewQuery>[]) {
      await expect(repo.usage.queryOverview({...range,...over})).rejects.toThrow()
    }
    await repo.usage.queryOverview({...range,end:"2026-10-02T00"})
    await repo.usage.queryOverview({...range,bucket:"day",end:"2027-09-02T00"})
    await expect(repo.usage.queryOverview({...range,bucket:"day",end:"2027-09-02T01"})).rejects.toThrow()
  } finally { db.close() }
})

test("actual app/session authorization, grants, HMAC paging, admin orphan history and API-key precedence", async () => {
  const db = new Database(":memory:")
  try {
    const repo = new BunSqliteRepo(db)
    initRepo(repo)
    for (const id of ["owner","viewer","other","empty","admin"]) {
      const u: User = { id:userId(id), name:id, email:id === "admin" ? "test@local.dev" : `${id}@example.invalid`, disabled:false, createdAt:new Date().toISOString() }
      const session: UserSession = {token:token(`ses_d08_${id}`),userId:u.id,createdAt:u.createdAt,authenticatedAt:Date.now(),expiresAt:new Date(Date.now()+3600000).toISOString()}
      await repo.users.create(u); await repo.sessions.create(session)
    }
    for (const [id, owner] of [["a","owner"],["b","other"],["c","owner"]] as const) {
      const k: ApiKey = { id:keyId(id),ownerId:userId(owner),name:id,key:`d08_${id}`,createdAt:new Date().toISOString(),modelMappingsEnabled:false,modelMappings:[] }
      await repo.apiKeys.save(k)
      await repo.usage.record(record({keyId:k.id}))
    }
    const historical: ApiKey = {id:keyId("orphan"),name:"Deleted",key:"deleted-key",createdAt:new Date().toISOString(),modelMappingsEnabled:false,modelMappings:[]}
    await repo.apiKeys.save(historical)
    await repo.usage.record(record({keyId:historical.id}))
    await repo.apiKeys.delete(historical.id)
    await repo.keyAssignments.assign(keyId("b"),userId("owner"),userId("other"))
    await repo.keyAssignments.assign(keyId("a"),userId("viewer"),userId("owner"))
    const base = "/api/token-usage/overview?start=2026-09-01T00&end=2026-09-02T00&axis=key"
    const request = (who?: string, suffix = "", apiKey?: string) => app.request(base+suffix, {headers: {
      ...(who ? {cookie:`session_token=ses_d08_${who}`} : {}), ...(apiKey ? {"x-api-key":`d08_${apiKey}`} : {}),
    }}, {SERVER_SECRET:"d08-secret"})
    const read = async (who?: string,suffix="",apiKey?:string): Promise<UsageOverview> => {
      const response=await request(who,suffix,apiKey); expect(response.status).toBe(200); return response.json()
    }
    expect((await request()).status).toBe(401)
    expect((await request("owner","&bucket=week")).status).toBe(400)
    expect((await request("owner","&as_user=other")).status).toBe(403)
    expect((await read("owner")).total.requests).toBe(6)
    expect((await read("viewer")).total.requests).toBe(2)
    expect((await read("empty")).total.hasRecords).toBe(false)
    expect((await read("owner","&key_id=orphan")).total.hasRecords).toBe(false)
    expect((await read("admin")).total.requests).toBe(8)
    expect((await read("admin","&key_id=orphan")).total.requests).toBe(2)
    expect((await read("admin","&key_id=b&as_user=other","a")).total.requests).toBe(2)
    await repo.observabilityShares.share(userId("owner"),userId("viewer"),userId("owner"))
    const shared=await read("viewer","&as_user=owner&limit=1")
    expect(shared.total.requests).toBe(4)
    expect(shared.breakdown.rows[0]?.value).toBe(sharedKeyRef("owner","a","d08-secret"))
    expect(shared.breakdown.nextCursor).toBe("1")
    const next=await read("viewer","&as_user=owner&limit=1&cursor=1")
    expect(next.breakdown.rows[0]?.value).toBe(sharedKeyRef("owner","c","d08-secret"))
    expect((await read("viewer",`&as_user=owner&key_id=${sharedKeyRef("owner","a","d08-secret")}`)).total.requests).toBe(2)
    expect((await read("viewer","&as_user=owner&key_id=a")).total.hasRecords).toBe(false)
    await repo.observabilityShares.unshare(userId("owner"),userId("viewer"))
    expect((await request("viewer","&as_user=owner")).status).toBe(403)
  } finally { db.close() }
})

test("UTC-day grouping, every closed axis, and offset cursors explicitly have no snapshot isolation", async () => {
  const db = new Database(":memory:")
  try {
    const repo = new BunSqliteRepo(db)
    await repo.usage.record(record({ keyId:keyId("b"), hour:"2026-09-01T23" }))
    await repo.usage.record(record({ keyId:keyId("c"), hour:"2026-09-02T00" }))
    const query: UsageOverviewQuery = {...range,end:"2026-09-03T00",bucket:"day",limit:1}
    const first=await repo.usage.queryOverview(query)
    expect(first.buckets.map(r=>[r.bucket,r.requests])).toEqual([["2026-09-01",2],["2026-09-02",2]])
    expect(first.breakdown.rows.map(r=>r.value)).toEqual(["b"])
    for (const axis of ["client","model","incomingModel"] as const) {
      const result=await repo.usage.queryOverview({...query,axis})
      expect(result.total).toEqual(first.total)
      expect(result.breakdown.rows[0]?.requests).toBe(4)
    }
    await repo.usage.record(record({keyId:keyId("a")}))
    const shifted=await repo.usage.queryOverview({...query,cursor:first.breakdown.nextCursor ?? undefined})
    // New preceding categories shift offsets; clients must restart for a fresh complete traversal.
    expect(shifted.breakdown.rows.map(r=>r.value)).toEqual(["b"])
    expect(shifted.total.requests).toBe(6)
    db.run("DELETE FROM usage WHERE key_id='a'")
    db.run("DELETE FROM usage_requests WHERE key_id='a'")
    expect((await repo.usage.queryOverview({...query,cursor:"1"})).breakdown.rows.map(r=>r.value)).toEqual(["c"])
  } finally { db.close() }
})

test("unresolved price row counts survive signed cancellation and observed zero, after fallback", async () => {
  const db = new Database(":memory:")
  try {
    const repo = new BunSqliteRepo(db)
    for (const [modelKey, tokens, price] of [["positive",100,null],["negative",-100,null],["zero",0,null],["free",0,0]] as const) {
      db.run("INSERT INTO usage (key_id,incoming_model,model,upstream,model_key,client,hour,dimension,tokens,unit_price) VALUES ('a','alias','model',NULL,?,'client',?,'input',?,?)", [modelKey,range.start,tokens,price])
    }
    let result = await repo.usage.queryOverview(range)
    expect(result.total.unpricedTokens).toBe(0)
    expect(result.total.input).toBe(100)
    expect(result.total.unpricedDimensionRows).toBe(3)
    expect(result.buckets[0]?.unpricedDimensionRows).toBe(3)
    expect(result.breakdown.rows[0]?.unpricedDimensionRows).toBe(3)
    db.run("UPDATE usage SET unit_price=0")
    result = await repo.usage.queryOverview(range)
    expect(result.total.unpricedDimensionRows).toBe(0)
    expect(result.total.observedDimensions).toEqual(["input"])
    // A known-free input resolves a null cache snapshot in the exact same identity.
    db.run("INSERT INTO usage (key_id,incoming_model,model,upstream,model_key,client,hour,dimension,tokens,unit_price) VALUES ('a','alias','model','', 'free','client',?,'input_cache_read',5,NULL)", [range.start])
    db.run("INSERT INTO usage (key_id,incoming_model,model,upstream,model_key,client,hour,dimension,tokens,unit_price) VALUES ('a','alias','model',NULL,'free','client',?,'future',5,NULL)", [range.start])
    result = await repo.usage.queryOverview(range)
    expect(result.total.unpricedDimensionRows).toBe(0)
    expect(result.total.cacheRead).toBe(5)
  } finally { db.close() }
})

test("accessible key IDs resolve owned and assigned existing keys in one bulk scope", async () => {
  const db = new Database(":memory:")
  try {
    const repo = new BunSqliteRepo(db)
    for (const [id,owner] of [["own","viewer"],["assigned","other"],["hidden","other"]] as const) {
      await repo.apiKeys.save({id:keyId(id),ownerId:userId(owner),name:id,key:`key_${id}`,createdAt:new Date().toISOString(),modelMappingsEnabled:false,modelMappings:[]})
    }
    for (const id of ["own","assigned","missing"]) await repo.keyAssignments.assign(keyId(id),userId("viewer"),userId("other"))
    expect(await repo.apiKeys.listAccessibleIds(userId("viewer"))).toEqual([keyId("assigned"),keyId("own")])
    expect(await repo.apiKeys.listAccessibleIds(userId("empty"))).toEqual([])
    await repo.apiKeys.delete(keyId("assigned"))
    expect(await repo.apiKeys.listAccessibleIds(userId("viewer"))).toEqual([keyId("own")])
  } finally { db.close() }
})
