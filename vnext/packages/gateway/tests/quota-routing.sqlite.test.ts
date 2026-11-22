// packages/gateway/tests/quota-routing.sqlite.test.ts
import { afterEach, expect, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { selectBindingForChatCompletions } from "../src/data-plane/chat-flow/shared/select-binding"
import { resolveBinding } from "../src/data-plane/routing/binding-resolver"
import { UpstreamPausedError } from "../src/data-plane/errors/upstream-paused"
import { describeGroupExhausted } from "../src/data-plane/routing/paused-route"
import { QuotaBalance, setQuotaBalanceForTests } from "../src/quota-balance/runtime"
import { newBalanceSession } from "../src/quota-balance/session-key"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"
import { NOW, enforcementFixture } from "./protection-enforcement-fixture"

const H = 3_600_000
const OWNER = "user_test_owner"
const G = `ug_${"1".repeat(32)}`
let fixture: Awaited<ReturnType<typeof enforcementFixture>>
let qb: QuotaBalance
const pending: Array<Promise<unknown>> = []
afterEach(() => { setQuotaBalanceForTests(null); fixture?.close(); __resetPlatformForTests() })

/** Custom upstreams (they serve model "shared" on chat and embeddings) owned by OWNER; a and b become group members in `group`. */
async function setup(ids: string[] = ["up_test_a", "up_test_b", "up_test_free"]) {
  fixture = await enforcementFixture(ids, { ownerId: OWNER })
  qb = new QuotaBalance({ repo: () => fixture.repo, now: () => fixture.clock.now, schedule: w => { pending.push(w.catch(() => {})) }, random: () => 0.5 }, { protection: () => fixture.runtime })
  setQuotaBalanceForTests(qb)
}
const read = (id: string, share: number, at = NOW - H) => fixture.repo.quotaBalance.recordRead(
  { upstreamId: id, at, source: "github", used: share * 1000, entitlement: 1000, unlimited: false, estimatedShareBefore: null, errorPoints: null, snapshotKey: null, unitForm: null, resetAt: null, costAdjustUsd: 0, entitlementChange: null }, at)
async function group(sortOrder: number, shares: { a: number; b: number }, settings = DEFAULT_GROUP_SETTINGS) {
  await fixture.repo.quotaBalance.createGroup({ id: G, ownerId: OWNER, name: "Pool", enabled: true, sortOrder, settings, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" })
  for (const [id, share] of [["up_test_a", shares.a], ["up_test_b", shares.b]] as const) {
    await fixture.repo.quotaBalance.setMembership(id, G, { nowMs: NOW, intervalHours: 6 })
    await read(id, share)
    await fixture.repo.quotaBalance.saveEstimator(id, { k: 0.02, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: NOW + 6 * H, lastErrorPoints: null }, NOW)
  }
  await qb.directory.get({ fresh: true })
}
const chat = (auth: Record<string, unknown> = {}) =>
  selectBindingForChatCompletions({ model: "shared", auth: { ownerId: OWNER, balanceSession: newBalanceSession({ apiKeyId: "key_test_1", explicitId: "conv-1", fingerprint: null }), ...auth } })
const servedBy = async (auth?: Record<string, unknown>) => { const sel = await chat(auth); return sel.kind === "ok" ? sel.binding.upstream : sel }

test("the group is one item: it sits where its own sort order puts it, and the member with the lowest projected share serves", async () => {
  await setup()
  await group(5, { a: 0.6, b: 0.2 }) // free has sort order 2: it comes first
  expect(await servedBy()).toBe("up_test_free")
  await fixture.repo.quotaBalance.updateGroup(G, { sortOrder: -1 }, "now")
  await qb.directory.get({ fresh: true })
  expect(await servedBy()).toBe("up_test_b")
})

test("the assignment is stored for the member that served and the next request keeps it", async () => {
  await setup()
  await group(-1, { a: 0.30, b: 0.33 })
  const first = await servedBy()
  expect(["up_test_a", "up_test_b"]).toContain(first)
  await Promise.all(pending.splice(0))
  expect(fixture.db.query("SELECT upstream_id FROM session_assignments").all()).toEqual([{ upstream_id: first }])
  expect(await servedBy()).toBe(first)
})

test("pinned requests bypass balancing and go to the pinned upstream even at the soft line", async () => {
  await setup()
  await group(-1, { a: 0.93, b: 0.2 })
  expect(await servedBy({ pin: "up_test_a" })).toBe("up_test_a")
  expect(fixture.db.query("SELECT COUNT(*) AS n FROM session_assignments").get()).toEqual({ n: 0 })
})

test("with every member at the soft line the group is skipped and matching continues", async () => {
  await setup()
  await group(-1, { a: 0.92, b: 0.93 })
  expect(await servedBy()).toBe("up_test_free")
})

test("with nothing else to serve the client gets group_quota_exhausted with Retry-After to the next reset, naming the group for its owner", async () => {
  await setup(["up_test_a", "up_test_b"])
  await group(-1, { a: 0.92, b: 0.93 })
  const sel = await chat()
  expect(sel).toMatchObject({ kind: "upstream-paused", code: "group_quota_exhausted", retryAfterSeconds: Math.ceil((Date.UTC(2026, 11, 1) - NOW) / 1000) })
  expect(sel.kind === "upstream-paused" && sel.message).toContain('"Pool"')
})

test("the overage policy lets new sessions use members above the soft line", async () => {
  await setup(["up_test_a", "up_test_b"])
  await group(-1, { a: 0.92, b: 0.93 }, { ...DEFAULT_GROUP_SETTINGS, exhaustedPolicy: "overage" })
  expect(["up_test_a", "up_test_b"]).toContain(await servedBy())
})

test("a cut-off member is out of the candidates and the other member serves directly", async () => {
  await setup()
  await group(-1, { a: 0.5, b: 0.6 })
  await fixture.pause({ targetId: "up_test_a" })
  await fixture.tick()
  expect(await servedBy()).toBe("up_test_b")
})

test("embeddings and other resolveBinding callers balance per request", async () => {
  await setup()
  await group(-1, { a: 0.6, b: 0.2 })
  expect((await resolveBinding("shared", "embeddings", { ownerId: OWNER }))?.upstream).toBe("up_test_b")
  await read("up_test_b", 0.7, NOW - 30 * 60_000)
  await fixture.repo.quotaBalance.updateGroup(G, { settings: { ...DEFAULT_GROUP_SETTINGS, softShare: 0.5 } }, "now")
  await qb.directory.get({ fresh: true })
  qb.facts.invalidate()
  expect((await resolveBinding("shared", "embeddings", { ownerId: OWNER }))?.upstream).toBe("up_test_free") // both members are at the soft line now
})

test("resolveBinding reports exhaustion as a 503 with the group_quota_exhausted code when nothing else can serve", async () => {
  await setup(["up_test_a", "up_test_b"])
  await group(-1, { a: 0.92, b: 0.93 })
  const error = await resolveBinding("shared", "embeddings", { ownerId: OWNER }).catch(e => e)
  expect(error).toBeInstanceOf(UpstreamPausedError)
  const response = (error as UpstreamPausedError).getResponse()
  expect(response.status).toBe(503)
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0)
  expect(await response.json()).toMatchObject({ error: { code: "group_quota_exhausted" } })
})

test("Retry-After is the earlier of the monthly reset and the end of a pause among the candidates; names are shown to the group's owner only", () => {
  const skipped = [{ groupId: G, name: "Pool", ownerId: OWNER }]
  const reset = Math.ceil((Date.UTC(2026, 11, 1) - NOW) / 1000)
  expect(describeGroupExhausted(skipped, [], OWNER, NOW).retryAfterSeconds).toBe(reset)
  expect(describeGroupExhausted(skipped, [NOW + 90_000], OWNER, NOW)).toMatchObject({ retryAfterSeconds: 90 })
  expect(describeGroupExhausted(skipped, [], OWNER, NOW).message).toContain('Upstream group "Pool"')
  expect(describeGroupExhausted(skipped, [], undefined, NOW).message).toContain("An upstream group")
  expect(describeGroupExhausted(skipped, [], undefined, NOW).message).not.toContain("Pool")
  expect(describeGroupExhausted([...skipped, { groupId: "ug_x", name: "Other", ownerId: "someone" }], [], OWNER, NOW).message).toContain('"Pool" and 1 other upstream group')
})

test("a group with no read yet is skipped without claiming quota exhaustion; nothing else serving gives the generic no-route answer", async () => {
  await setup(["up_test_a", "up_test_b"])
  await group(-1, { a: 0.3, b: 0.3 })
  fixture.db.run("DELETE FROM quota_reads")
  fixture.db.run("DELETE FROM upstream_quota_state")
  qb.facts.invalidate()
  const sel = await chat()
  expect(sel.kind).toBe("no-eligible-binding")
})

test("D32: count_tokens ignores the soft line (it consumes no premium quota) while embeddings keep it", async () => {
  await setup(["up_test_a", "up_test_b"])
  await group(-1, { a: 0.92, b: 0.93 })
  expect(["up_test_a", "up_test_b"]).toContain((await resolveBinding("shared", "messages_count_tokens", { ownerId: OWNER }))?.upstream)
  const error = await resolveBinding("shared", "embeddings", { ownerId: OWNER }).catch(e => e)
  expect(error).toBeInstanceOf(UpstreamPausedError)
})
