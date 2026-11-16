import { beforeEach, expect, test } from "bun:test"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { __resetLokiMirrorPullsForTests, LokiProvider } from "../provider"
import { newLokiMirrorState, type LokiState } from "../state"

const start = 1_800_000_000_000
const account = { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" }
const mirrorId = `lkmid_${"b".repeat(32)}`
const source = { kind: "mirror" as const, origin: "https://central.example", upstreamId: "up_loki_central",
  mirrorId, mirrorSecret: `lkm_${"c".repeat(64)}` }
const credential = (token: string, expiresAt: number, acct = account) => ({ accessToken: token, tokenType: "Bearer" as const, expiresAt, account: acct })

let clock = start
let central: () => Response | Promise<Response>
let pulls = 0
let lokiBearers: string[] = []

function device(initial: ReturnType<typeof credential> | undefined) {
  const row: StoredUpstreamRecord<LokiState> = { id: "up_loki_device", rowIncarnation: "i", ownerId: "owner", provider: "loki",
    name: "Loki", enabled: true, sortOrder: 0, config: { profileId: "loki-df-v1" }, state: newLokiMirrorState(source, initial, start),
    catalogGeneration: 0, credentialGeneration: 0, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "", updatedAt: "" }
  const provider = new LokiProvider(row, async () => row,
    async (_url, init) => { lokiBearers.push(new Headers(init.headers).get("authorization") ?? ""); return Response.json({ data: [] }) },
    undefined,
    { now: () => clock,
      save: async updater => { row.state = updater(row.state) as LokiState },
      mirrorFetcher: async () => { pulls++; return central() } })
  return { row, provider }
}
const ok = (token: string, expiresAt = clock + 3_600_000) =>
  () => Response.json({ version: 1, profileId: "loki-df-v1", mirrorId, credential: credential(token, expiresAt) })

beforeEach(() => { __resetLokiMirrorPullsForTests(); clock = start; pulls = 0; lokiBearers = []; central = ok("fresh") })

test("a token with more than five minutes left is used without pulling", async () => {
  const { provider } = device(credential("stored", start + 600_000))
  await provider.getLiveModels()
  expect(pulls).toBe(0)
  expect(lokiBearers).toEqual(["Bearer stored"])
})

test("a near-expiry token is refreshed once for concurrent callers and persisted", async () => {
  const { provider, row } = device(credential("stored", start + 120_000))
  await Promise.all([provider.getLiveModels(), provider.getLiveModels(), provider.getLiveModels()])
  expect(pulls).toBe(1)
  expect(lokiBearers).toEqual(["Bearer fresh", "Bearer fresh", "Bearer fresh"])
  expect(row.state.credential?.accessToken).toBe("fresh")
})

test("a missing token is pulled on first use", async () => {
  const { provider, row } = device(undefined)
  await provider.getLiveModels()
  expect(lokiBearers).toEqual(["Bearer fresh"])
  expect(row.state.account).toEqual(account)
})

test("failures keep the unexpired token and back off for 30 seconds", async () => {
  const { provider } = device(credential("stored", start + 120_000))
  central = () => new Response(null, { status: 502 })
  await provider.getLiveModels()
  await provider.getLiveModels()
  expect(pulls).toBe(1)
  expect(lokiBearers).toEqual(["Bearer stored", "Bearer stored"])
  clock += 31_000
  central = ok("fresh")
  await provider.getLiveModels()
  expect(pulls).toBe(2)
  expect(lokiBearers.at(-1)).toBe("Bearer fresh")
})

test("an expired token with a failed pull is unavailable", async () => {
  const { provider } = device(credential("stored", start - 1))
  central = () => Response.json({ error: { code: "credential_unavailable" } }, { status: 503 })
  await expect(provider.getLiveModels()).rejects.toThrow("loki_credential_unavailable")
})

test("revocation is recorded and stops automatic pulls", async () => {
  const { provider, row } = device(credential("stored", start + 120_000))
  central = () => Response.json({ error: { code: "invalid_mirror" } }, { status: 401 })
  await provider.getLiveModels()
  expect(row.state.errorCode).toBe("mirror_revoked")
  clock += 60_000
  await provider.getLiveModels()
  expect(pulls).toBe(1)
  clock = start + 120_000
  await expect(provider.getLiveModels()).rejects.toThrow("loki_credential_unavailable")
})

test("a token for another account is refused and stops automatic pulls", async () => {
  const { provider, row } = device(credential("stored", start + 120_000))
  central = () => Response.json({ version: 1, profileId: "loki-df-v1", mirrorId,
    credential: credential("other", clock + 3_600_000, { homeAccountId: "other", tenantId: account.tenantId }) })
  await provider.getLiveModels()
  expect(row.state.errorCode).toBe("account_mismatch")
  expect(lokiBearers).toEqual(["Bearer stored"])
  clock += 60_000
  await provider.getLiveModels()
  expect(pulls).toBe(1)
})
