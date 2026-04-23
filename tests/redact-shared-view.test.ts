import { test, expect, describe } from "bun:test"
import { sharedKeyRef, sharedAccountRef, sharedRelayRef, redactForSharedView } from "../src/lib/redact-shared-view"

const SECRET = "test-secret-do-not-use-in-prod"

describe("HMAC surrogates", () => {
  test("sharedKeyRef is deterministic per (owner, realId)", () => {
    expect(sharedKeyRef("owner-1", "key-abc", SECRET)).toBe(sharedKeyRef("owner-1", "key-abc", SECRET))
  })

  test("different owners with same realId → different surrogates (no cross-owner correlation)", () => {
    expect(sharedKeyRef("owner-1", "key-abc", SECRET)).not.toBe(sharedKeyRef("owner-2", "key-abc", SECRET))
  })

  test("different kinds with same inputs → different surrogates", () => {
    expect(sharedKeyRef("o", "x", SECRET)).not.toBe(sharedAccountRef("o", "x", SECRET))
    expect(sharedAccountRef("o", "x", SECRET)).not.toBe(sharedRelayRef("o", "x", SECRET))
  })

  test("surrogate is base64url, length 16, no = padding", () => {
    const s = sharedKeyRef("owner-1", "key-abc", SECRET)
    expect(s).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  test("rotating the secret changes the surrogate", () => {
    expect(sharedKeyRef("owner-1", "key-abc", "secret-A")).not.toBe(sharedKeyRef("owner-1", "key-abc", "secret-B"))
  })
})

describe("redactForSharedView — token usage records", () => {
  test("replaces keyId with sharedKeyRef, keeps keyName + metrics", () => {
    const records = [
      { keyId: "key-abc", keyName: "My Key", inputTokens: 100, outputTokens: 50, hour: "2026-04-23T10" },
    ]
    const out = redactForSharedView({ kind: "tokenUsage", payload: records, ownerId: "owner-1", secret: SECRET })
    expect(out[0].keyId).toBe(sharedKeyRef("owner-1", "key-abc", SECRET))
    expect(out[0].keyName).toBe("My Key")
    expect(out[0].inputTokens).toBe(100)
    expect(out[0].outputTokens).toBe(50)
  })
})

describe("redactForSharedView — upstream accounts", () => {
  test("replaces id with sharedAccountRef; strips access_token / refresh_token / scopes", () => {
    const accounts = [{
      id: "acct-1",
      login: "octocat",
      avatar_url: "https://x/a.png",
      active: true,
      token_valid: true,
      access_token: "ghp_secret",
      refresh_token: "ghr_secret",
      scopes: ["repo", "read:user"],
      quota: { remaining: 1000 },
    }]
    const out = redactForSharedView({ kind: "upstreamAccounts", payload: accounts, ownerId: "owner-1", secret: SECRET })
    expect(out[0].id).toBe(sharedAccountRef("owner-1", "acct-1", SECRET))
    expect(out[0].login).toBe("octocat")
    expect(out[0].avatar_url).toBe("https://x/a.png")
    expect(out[0].active).toBe(true)
    expect(out[0].token_valid).toBe(true)
    expect(out[0].quota).toEqual({ remaining: 1000 })
    expect((out[0] as any).access_token).toBeUndefined()
    expect((out[0] as any).refresh_token).toBeUndefined()
    expect((out[0] as any).scopes).toBeUndefined()
  })
})

describe("redactForSharedView — relays", () => {
  test("replaces clientId with sharedRelayRef; strips clientName/hostname/IP/gatewayUrl", () => {
    const relays = [{
      clientId: "rly-9",
      clientName: "laptop@host (1.2.3.4)",
      hostname: "host.local",
      gatewayUrl: "https://gw.local",
      keyId: "key-abc",
      keyName: "My Key",
      ownerId: "owner-1",
      lastSeenAt: "2026-04-23T10:00:00Z",
      isOnline: true,
      isActive: false,
    }]
    const out = redactForSharedView({ kind: "relays", payload: relays, ownerId: "owner-1", secret: SECRET })
    expect(out[0].id).toBe(sharedRelayRef("owner-1", "rly-9", SECRET))
    expect(out[0].clientLabel).toBe("My Key")
    expect(out[0].lastSeenAt).toBe("2026-04-23T10:00:00Z")
    expect(out[0].isOnline).toBe(true)
    expect((out[0] as any).clientName).toBeUndefined()
    expect((out[0] as any).hostname).toBeUndefined()
    expect((out[0] as any).gatewayUrl).toBeUndefined()
    expect((out[0] as any).keyId).toBeUndefined()
    expect((out[0] as any).ownerId).toBeUndefined()
  })

  test("clientLabel falls back to 'Relay #N' when keyName missing", () => {
    const relays = [
      { clientId: "rly-1", lastSeenAt: "t", isOnline: true, isActive: false },
      { clientId: "rly-2", lastSeenAt: "t", isOnline: true, isActive: false },
    ]
    const out = redactForSharedView({ kind: "relays", payload: relays, ownerId: "owner-1", secret: SECRET })
    expect(out[0].clientLabel).toBe("Relay #1")
    expect(out[1].clientLabel).toBe("Relay #2")
  })
})
