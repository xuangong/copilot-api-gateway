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

let background: Promise<unknown>[] = []
const deferred = () => { let resolve!: (r: Response) => void; const promise = new Promise<Response>(r => { resolve = r }); return { promise, resolve } }
const freshBody = (token: string) => Response.json({ version: 1, profileId: "loki-df-v1", mirrorId, credential: credential(token, clock + 3_600_000) })

function device(initial: ReturnType<typeof credential> | undefined, extra: { noSave?: boolean; save?: () => Promise<void>; waitMs?: number } = {}) {
  const row: StoredUpstreamRecord<LokiState> = { id: "up_loki_device", rowIncarnation: "i", ownerId: "owner", provider: "loki",
    name: "Loki", enabled: true, sortOrder: 0, config: { profileId: "loki-df-v1" }, state: newLokiMirrorState(source, initial, start),
    catalogGeneration: 0, credentialGeneration: 0, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "", updatedAt: "" }
  const provider = new LokiProvider(row, async () => row,
    async (_url, init) => { lokiBearers.push(new Headers(init.headers).get("authorization") ?? ""); return Response.json({ data: [] }) },
    undefined,
    { now: () => clock,
      background: work => { background.push(work) }, ...(extra.waitMs ? { waitMs: extra.waitMs } : {}),
      ...(extra.noSave ? {} : { save: extra.save ?? (async updater => { row.state = updater(row.state) as LokiState }) }),
      mirrorFetcher: async () => { pulls++; return central() } })
  return { row, provider }
}
const ok = (token: string, expiresAt = clock + 3_600_000) =>
  () => Response.json({ version: 1, profileId: "loki-df-v1", mirrorId, credential: credential(token, expiresAt) })

beforeEach(() => { __resetLokiMirrorPullsForTests(); clock = start; pulls = 0; lokiBearers = []; background = []; central = ok("fresh") })

test("a token with more than five minutes left is used without pulling", async () => {
  const { provider } = device(credential("stored", start + 600_000))
  await provider.getLiveModels()
  expect(pulls).toBe(0)
  expect(lokiBearers).toEqual(["Bearer stored"])
})

test("a near-expiry token is returned immediately while the refresh runs in the background", async () => {
  const { provider, row } = device(credential("stored", start + 120_000))
  const gate = deferred()
  central = () => gate.promise
  await Promise.all([provider.getLiveModels(), provider.getLiveModels()])
  expect(lokiBearers).toEqual(["Bearer stored", "Bearer stored"])
  expect(pulls).toBe(1)
  expect(background.length).toBe(2)
  gate.resolve(freshBody("fresh"))
  await Promise.all(background)
  expect(row.state.credential?.accessToken).toBe("fresh")
  await provider.getLiveModels()
  expect(lokiBearers.at(-1)).toBe("Bearer fresh")
  expect(pulls).toBe(1)
})

test("callers without a usable token join one pull; a later caller starts a new one after backoff", async () => {
  const { provider } = device(undefined)
  const gate = deferred()
  central = () => gate.promise
  const calls = [provider.getLiveModels(), provider.getLiveModels(), provider.getLiveModels()]
  await Promise.resolve()
  gate.resolve(new Response(null, { status: 502 }))
  const settled = await Promise.allSettled(calls)
  expect(settled.map(r => r.status)).toEqual(["rejected", "rejected", "rejected"])
  expect(pulls).toBe(1)
  await expect(provider.getLiveModels()).rejects.toThrow("loki_credential_unavailable")
  expect(pulls).toBe(1)
  clock += 31_000
  central = ok("fresh")
  await provider.getLiveModels()
  expect(pulls).toBe(2)
  expect(lokiBearers).toEqual(["Bearer fresh"])
})

test("waiting for a pull is bounded", async () => {
  const { provider } = device(undefined, { waitMs: 20 })
  central = () => deferred().promise
  await expect(provider.getLiveModels()).rejects.toThrow("loki_credential_unavailable")
  expect(pulls).toBe(1)
  // The never-settling entry is stale past the deadline and is replaced.
  clock += 21
  await expect(provider.getLiveModels()).rejects.toThrow("loki_credential_unavailable")
  expect(pulls).toBe(2)
})

test("a failed save backs off for 30 seconds and keeps the old token", async () => {
  const { provider } = device(credential("stored", start + 120_000), { save: async () => { throw new Error("cas") } })
  await provider.getLiveModels()
  await Promise.all(background)
  await provider.getLiveModels()
  expect(pulls).toBe(1)
  expect(lokiBearers).toEqual(["Bearer stored", "Bearer stored"])
})

test("without a save option nothing is pulled", async () => {
  const { provider } = device(credential("stored", start + 120_000), { noSave: true })
  await provider.getLiveModels()
  expect(pulls).toBe(0)
  expect(background).toEqual([])
  expect(lokiBearers).toEqual(["Bearer stored"])
})

test("an unavailable central keeps the unexpired token", async () => {
  const { provider } = device(credential("stored", start + 120_000))
  central = () => Response.json({ error: { code: "credential_unavailable" } }, { status: 503 })
  await provider.getLiveModels()
  await Promise.all(background)
  clock += 1_000
  await provider.getLiveModels()
  expect(lokiBearers).toEqual(["Bearer stored", "Bearer stored"])
  expect(pulls).toBe(1)
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
  await Promise.all(background)
  await provider.getLiveModels()
  expect(pulls).toBe(1)
  expect(lokiBearers).toEqual(["Bearer stored", "Bearer stored"])
  clock += 31_000
  central = ok("fresh")
  await provider.getLiveModels()
  await Promise.all(background)
  expect(pulls).toBe(2)
  await provider.getLiveModels()
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
  await Promise.all(background)
  expect(row.state.errorCode).toBe("mirror_revoked")
  clock += 60_000
  await provider.getLiveModels()
  expect(pulls).toBe(1)
  clock = start + 120_000 // expiresAt <= now counts as expired
  await expect(provider.getLiveModels()).rejects.toThrow("loki_credential_unavailable")
})

test("a token for another account is refused and stops automatic pulls", async () => {
  const { provider, row } = device(credential("stored", start + 120_000))
  central = () => Response.json({ version: 1, profileId: "loki-df-v1", mirrorId,
    credential: credential("other", clock + 3_600_000, { homeAccountId: "other", tenantId: account.tenantId }) })
  await provider.getLiveModels()
  await Promise.all(background)
  expect(row.state.errorCode).toBe("account_mismatch")
  expect(lokiBearers).toEqual(["Bearer stored"])
  clock += 60_000
  await provider.getLiveModels()
  expect(pulls).toBe(1)
})
