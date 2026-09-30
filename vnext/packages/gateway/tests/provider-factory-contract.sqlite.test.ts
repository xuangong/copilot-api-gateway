import { expect, test } from "bun:test"
import type { UpstreamKind } from "@vibe-llm/protocols/common"
import type { UpstreamRecord } from "../src/repo/types.ts"
import { createProviderFromUpstream } from "../src/data-plane/providers/registry.ts"
import { setupTestPlatform } from "./_setup-platform.ts"

const accountId = "00000000-0000-4000-8000-000000000001"
const now = "2026-01-01T00:00:00.000Z"
const configurations = {
  copilot: { config: { githubToken: "fixture-token" }, state: null },
  custom: { config: { name: "fixture", baseUrl: "https://custom.example/v1", apiKey: "fixture-key", endpoints: ["chat_completions"] }, state: null },
  azure: { config: { name: "fixture", endpoint: "https://fixture.openai.azure.com", apiKey: "fixture-key", deployment: "fixture-model", apiVersion: "2024-02-15-preview", endpoints: ["chat_completions"] }, state: null },
  sdf: { config: { name: "fixture", substrateToken: "fixture-token" }, state: null },
  codex: {
    config: { accounts: [{ chatgptAccountId: accountId, email: null, chatgptUserId: null, planType: null }] },
    state: { accounts: [{ chatgptAccountId: accountId, refresh_token: "fixture-refresh", state: "active", state_updated_at: now, openaiDeviceId: accountId, accessToken: null, quotaSnapshot: null }] },
  },
  "claude-code": {
    config: { accounts: [{ accountUuid: accountId, email: null, organizationUuid: null, subscriptionType: null, rateLimitTier: null }] },
    state: { accounts: [{ accountUuid: accountId, tokenKind: "oauth", refreshToken: "fixture-refresh", state: "active", stateUpdatedAt: now, accessToken: null, quotaSnapshot: null, usageProbeSnapshot: null }] },
  },
} satisfies Record<UpstreamKind, Pick<UpstreamRecord, "config" | "state">>

function upstream(provider: UpstreamKind): UpstreamRecord {
  return {
    id: provider, provider, name: "fixture", enabled: true, sortOrder: 0,
    ...configurations[provider], flagOverrides: {}, disabledPublicModelIds: [],
    proxyFallbackList: [{ id: "direct_fetch" }], createdAt: now, updatedAt: now,
  }
}

for (const kind of Object.keys(configurations) as UpstreamKind[]) {
  test(`stored ${kind} resolves its factory without discovery or credential exchange`, async () => {
    const { repo, db } = setupTestPlatform()
    try {
      await repo.upstreams.save(upstream(kind))
      const stored = await repo.upstreams.getById(kind)
      if (!stored) throw new Error("Missing persisted fixture")
      const selected: string[] = []
      let requests = 0
      const provider = await createProviderFromUpstream(stored, undefined, id => {
        selected.push(id)
        return async () => { requests++; throw new Error("Construction must not dial an upstream") }
      })
      expect(provider?.kind).toBe(kind)
      expect(selected).toEqual([kind])
      expect(requests).toBe(0)
    } finally { db.close() }
  })

  test(`${kind} selects the configured fetcher before validating provider credentials`, async () => {
    const { repo, db } = setupTestPlatform()
    try {
      await repo.upstreams.save(upstream(kind))
      const stored = await repo.upstreams.getById(kind)
      if (!stored) throw new Error("Missing persisted fixture")
      const failure = new Error("Configured proxy is unavailable")
      await expect(createProviderFromUpstream({ ...stored, config: {}, state: null }, undefined, () => {
        throw failure
      })).rejects.toBe(failure)
    } finally { db.close() }
  })
}

for (const kind of ["future-provider", "toString", "__proto__"]) {
  test(`unknown persisted kind ${kind} returns null before selecting a fetcher`, async () => {
    const { repo, db } = setupTestPlatform()
    try {
      await repo.upstreams.save(upstream("custom"))
      // A database written by another version is not constrained by this build's union.
      db.query("UPDATE upstreams SET provider = ? WHERE id = ?").run(kind, "custom")
      const stored = await repo.upstreams.getById("custom")
      if (!stored) throw new Error("Missing persisted fixture")
      let selected = false
      const provider = await createProviderFromUpstream(stored, undefined, () => {
        selected = true
        throw new Error("Unknown kinds must not select a fetcher")
      })
      expect(provider).toBeNull()
      expect(selected).toBe(false)
    } finally { db.close() }
  })
}

test("Copilot without stored credentials keeps the optional request-token fallback", async () => {
  const { repo, db } = setupTestPlatform()
  try {
    await repo.upstreams.save({ ...upstream("copilot"), config: {} })
    const stored = await repo.upstreams.getById("copilot")
    if (!stored) throw new Error("Missing persisted fixture")
    expect(await createProviderFromUpstream(stored)).toBeNull()
    const provider = await createProviderFromUpstream(stored, { copilotToken: "fixture-fallback", accountType: "individual" })
    expect(provider?.kind).toBe("copilot")
  } finally { db.close() }
})
