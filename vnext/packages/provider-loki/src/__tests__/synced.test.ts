import { expect, test } from "bun:test"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { lokiProviderPlugin } from "../plugin"
import { LokiProvider } from "../provider"
import { lokiSyncState, readLokiState, type LokiState } from "../state"

const account = { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" }
const central = (overrides: Partial<LokiState> = {}): LokiState => ({
  version: 1, profileId: "loki-df-v1", generation: "g", syncSecretHash: "secret-hash", revision: 3, assistantStatus: "authorized",
  account, credential: { accessToken: "central-token", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000, account },
  lastReceipt: { requestId: "request-one", payloadHash: "payload-hash" }, ...overrides,
})
const row = (state: unknown): StoredUpstreamRecord => ({
  id: "up_loki", rowIncarnation: "incarnation", ownerId: "owner", provider: "loki", name: "Loki", enabled: true, sortOrder: 0,
  config: { profileId: "loki-df-v1" }, state, catalogGeneration: 0, credentialGeneration: 0, flagOverrides: {},
  disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "", updatedAt: "",
})
const catalog = { data: [{ id: "claude-opus-5.5", supported_endpoints: ["/v1/messages"] }] }

test("Loki is syncable and its sync view withholds the pairing authority", () => {
  expect(lokiProviderPlugin.syncable).toBe(true)
  const legacy = { ...central(), mirrors: [{ id: "lkmid_x", label: "old", secretHash: "hash-of-mirror", createdAt: 1 }] }
  const view = lokiProviderPlugin.syncView!(row(legacy) as never)
  expect(view.config).toEqual({ profileId: "loki-df-v1" })
  const text = JSON.stringify(view.state)
  for (const secret of ["secret-hash", "payload-hash", "lastReceipt", "syncSecretHash", "mirror"]) expect(text).not.toContain(secret)
  expect(text).toContain("central-token")
  const onDevice = readLokiState(view.state)
  expect(onDevice.syncSecretHash).toBe("")
  expect(onDevice.credential?.accessToken).toBe("central-token")
  expect(lokiSyncState(central())).not.toHaveProperty("syncSecretHash")
})

test("a sync view omits credential and account when the central state has no pairing secret", () => {
  const view = lokiProviderPlugin.syncView!(row(central({ syncSecretHash: "" })) as never)
  expect(view.state).not.toHaveProperty("credential")
  expect(view.state).not.toHaveProperty("account")
  expect(JSON.stringify(view.state)).not.toContain("central-token")
})

test("a synced Loki upstream uses the stored credential without a pairing secret", async () => {
  const synced = row(lokiSyncState(central()))
  const bearers: string[] = []
  const provider = new LokiProvider(synced, async () => synced, async (_url, init) => {
    bearers.push(new Headers(init.headers).get("authorization") ?? "")
    return Response.json(catalog)
  }, undefined, { credentialsReadOnly: true })
  await provider.getModels()
  expect(bearers).toEqual(["Bearer central-token"])
})

test("without credentialsReadOnly a state lacking the pairing secret is still unusable", async () => {
  const unpaired = row(lokiSyncState(central()))
  const provider = new LokiProvider(unpaired, async () => unpaired, async () => Response.json(catalog))
  await expect(provider.getModels()).rejects.toThrow("loki_credential_unavailable")
})

test("a synced Loki upstream with an expired credential waits for the next sync", async () => {
  const expired = row(lokiSyncState(central({ credential: { accessToken: "old", tokenType: "Bearer", expiresAt: Date.now() - 1, account } })))
  let calls = 0
  const provider = new LokiProvider(expired, async () => expired, async () => { calls++; return Response.json(catalog) },
    undefined, { credentialsReadOnly: true })
  await expect(provider.getModels()).rejects.toThrow("loki_credential_unavailable")
  expect(calls).toBe(0)
})
