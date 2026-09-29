import { expect, test } from "bun:test"
import { serializeUpstream } from "../src/control-plane/upstreams/public-dto"
import type { UpstreamRecord } from "../src/repo/types"

const codex = (overrides: Record<string, unknown> = {}): UpstreamRecord<unknown> => ({
  id: "codex-1", ownerId: "user-1", provider: "codex", name: "Codex", enabled: true, sortOrder: 0,
  config: { accounts: [{ email: null, chatgptAccountId: "account-1", chatgptUserId: null, planType: null }] },
  state: { accounts: [{
    chatgptAccountId: "account-1", credentialRevision: "revision-secret", refresh_token: null,
    state: "active", state_updated_at: "2026-01-01T00:00:00Z", openaiDeviceId: "device-secret",
    accessToken: { token: "bearer-secret", expiresAt: null, refreshedAt: "2026-01-01T00:00:00Z" },
    quotaSnapshot: null,
    ...overrides,
  }] },
  flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
})

test("Codex public DTO derives unknown-expiry nonrenewable status without private state", () => {
  const dto = serializeUpstream(codex())
  expect(dto.credentialStatus).toEqual({
    health: "active", renewable: false, expiresAt: null, expiryKnown: false, quotaObservedAt: null,
  })
  const json = JSON.stringify(dto)
  for (const secret of ["bearer-secret", "revision-secret", "device-secret", "refresh_token", "state_updated_at"]) {
    expect(json).not.toContain(secret)
  }
})

test("Codex public DTO distinguishes an expired access-only bearer", () => {
  const dto = serializeUpstream(codex({ accessToken: {
    token: "bearer-secret", expiresAt: Date.now() - 1000, refreshedAt: "2026-01-01T00:00:00Z",
  } }))
  expect(dto.credentialStatus?.health).toBe("credential_expired")
  expect(dto.credentialStatus?.expiryKnown).toBe(true)
})

test("Codex public DTO reports only the latest quota observation time", () => {
  const dto = serializeUpstream(codex({ refresh_token: "refresh-secret", quotaSnapshot: {
    standard: { fetchedAt: 42, data: { secret: "quota-private" } },
    priority: { fetchedAt: 99, data: { secret: "quota-private" } },
  } }))
  expect(dto.credentialStatus).toMatchObject({ health: "active", renewable: true, quotaObservedAt: 99 })
  expect(JSON.stringify(dto)).not.toContain("quota-private")
  expect(JSON.stringify(dto)).not.toContain("refresh-secret")
})
