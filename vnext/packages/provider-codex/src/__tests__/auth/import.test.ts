import { describe, expect, test } from "bun:test"
import { importCodexFromAuthJson, importCodexFromCallback, importCodexFromJson, previewCodexJson } from "../../auth/import"

const jwt = (claims: Record<string, unknown>): string =>
  `header.${btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}.signature`

const accountClaims = (accountId: string, extra: Record<string, unknown> = {}): string => jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: "user-1", chatgpt_plan_type: "plus" },
  email: "person@example.com",
  ...extra,
})

const future = Math.floor(Date.now() / 1000) + 3600

describe("Codex JSON import", () => {
  test.each([
    ["auth tokens", { tokens: { access_token: "access-1", refresh_token: "refresh-1", id_token: accountClaims("acct-1") } }],
    ["single credentials", { credentials: { access_token: "access-1", refresh_token: "refresh-1", id_token: accountClaims("acct-1") } }],
    ["accounts", { accounts: [{ credentials: { access_token: "access-1", refresh_token: "refresh-1", id_token: accountClaims("acct-1") } }] }],
    ["nested accounts", { data: { accounts: [{ credentials: { access_token: "access-1", refresh_token: "refresh-1", id_token: accountClaims("acct-1") } }] } }],
  ])("previews and imports %s without changing the bearer", async (_name, document) => {
    const raw = JSON.stringify(document)
    const rows = await previewCodexJson(raw)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sourceIndex: 0, chatgptAccountId: "acct-1", renewable: true, expiresAt: null, issues: [] })
    expect(JSON.stringify(rows)).not.toContain("access-1")
    expect(JSON.stringify(rows)).not.toContain("refresh-1")
    const imported = await importCodexFromJson(raw, 0)
    expect(imported.config.accounts).toHaveLength(1)
    expect(imported.state.accounts).toHaveLength(1)
    expect(imported.state.accounts[0]?.accessToken).toMatchObject({ token: "access-1", expiresAt: null })
    expect(imported.state.accounts[0]?.refresh_token).toBe("refresh-1")
  })

  test("rejects ambiguous envelopes without echoing credentials", async () => {
    const raw = JSON.stringify({ tokens: { access_token: "secret-access" }, accounts: [] })
    await expect(previewCodexJson(raw)).rejects.toThrow(/ambiguous/i)
    try { await importCodexFromJson(raw, 0) } catch (error) {
      expect(String(error)).not.toContain("secret-access")
    }
  })

  test("keeps stable source indexes and issues when another row is invalid", async () => {
    const raw = JSON.stringify({ accounts: [
      { platform: "anthropic", credentials: { access_token: "other-secret" } },
      { name: "broken", credentials: { access_token: "bad-secret" } },
      { name: "working", credentials: { access_token: "valid-secret", chatgpt_account_id: "acct-3", expires_at: future } },
    ] })
    const rows = await previewCodexJson(raw)
    expect(rows.map(row => row.sourceIndex)).toEqual([1, 2])
    expect(rows[0]?.issues.length).toBeGreaterThan(0)
    expect(rows[1]).toMatchObject({ sourceIndex: 2, name: "working", chatgptAccountId: "acct-3", renewable: false, expiresAt: future * 1000, issues: [] })
    expect(JSON.stringify(rows)).not.toContain("secret")
    await expect(importCodexFromJson(raw, 1)).rejects.toThrow()
    expect((await importCodexFromJson(raw, 2)).state.accounts[0]?.accessToken?.token).toBe("valid-secret")
  })

  test("accepts access-only unknown expiry with unknown display identity", async () => {
    const imported = await importCodexFromAuthJson(JSON.stringify({ tokens: { access_token: "opaque-bearer", account_id: "acct-1" } }))
    expect(imported.config.accounts[0]).toEqual({ email: null, chatgptAccountId: "acct-1", chatgptUserId: null, planType: null })
    expect(imported.state.accounts[0]?.refresh_token).toBeNull()
    expect(imported.state.accounts[0]?.accessToken?.expiresAt).toBeNull()
  })

  test("JWT access expiry wins over metadata and known expiry is previewed", async () => {
    const raw = JSON.stringify({ tokens: { access_token: accountClaims("acct-1", { exp: future }), expires_at: future + 7200 } })
    expect((await previewCodexJson(raw))[0]?.expiresAt).toBe(future * 1000)
    expect((await importCodexFromJson(raw, 0)).state.accounts[0]?.accessToken?.expiresAt).toBe(future * 1000)
  })

  test.each([0, "0", null, undefined])("treats metadata expiry %p as unknown", async expiresAt => {
    const raw = JSON.stringify({ credentials: { access_token: "opaque", account_id: "acct-1", expires_at: expiresAt } })
    expect((await previewCodexJson(raw))[0]?.expiresAt).toBeNull()
  })

  test("rejects conflicting token account IDs even with an explicit override", async () => {
    const raw = JSON.stringify({ tokens: {
      access_token: accountClaims("access-account"), id_token: accountClaims("id-account"), account_id: "override-account",
    } })
    const rows = await previewCodexJson(raw)
    expect(rows[0]?.issues.length).toBeGreaterThan(0)
    await expect(importCodexFromJson(raw, 0)).rejects.toThrow(/account/i)
  })

  test("rejects expired access-only rows but allows expired renewable rows", async () => {
    const expired = Math.floor(Date.now() / 1000) - 3600
    const only = JSON.stringify({ credentials: { access_token: "opaque", account_id: "acct-1", expires_at: expired } })
    expect((await previewCodexJson(only))[0]?.issues.length).toBeGreaterThan(0)
    await expect(importCodexFromJson(only, 0)).rejects.toThrow()
    const renewable = JSON.stringify({ credentials: { access_token: "opaque", refresh_token: "refresh", account_id: "acct-1", expires_at: expired } })
    expect((await previewCodexJson(renewable))[0]?.issues).toEqual([])
  })

  test("imports an explicit flat bearer and a refresh-only account", async () => {
    const flat = JSON.stringify({ access_token: "flat-bearer", account_id: "flat-account" })
    expect((await importCodexFromJson(flat, 0)).state.accounts[0]?.accessToken?.token).toBe("flat-bearer")
    const refreshOnly = JSON.stringify({ tokens: { refresh_token: "refresh-only", account_id: "refresh-account" } })
    expect((await previewCodexJson(refreshOnly))[0]).toMatchObject({ renewable: true, expiresAt: null, importable: true })
    const imported = await importCodexFromJson(refreshOnly, 0)
    expect(imported.state.accounts[0]?.accessToken).toBeNull()
    expect(imported.state.accounts[0]?.refresh_token).toBe("refresh-only")
  })

  test("accepts ISO and epoch-second expiry, rejecting malformed or wrongly typed expiry", async () => {
    const expiry = "2030-02-03T04:05:06Z"
    const document = (expires_at: unknown) => JSON.stringify({ tokens: { access_token: "opaque", account_id: "acct-1", expires_at } })
    expect((await previewCodexJson(document(expiry)))[0]?.expiresAt).toBe(Date.parse(expiry))
    expect((await previewCodexJson(document(String(Date.parse(expiry) / 1000))))[0]?.expiresAt).toBe(Date.parse(expiry))
    for (const invalid of [true, -1, "tomorrow", "2030-02-03", {}, []]) {
      expect((await previewCodexJson(document(invalid)))[0]?.importable).toBe(false)
      await expect(importCodexFromJson(document(invalid), 0)).rejects.toThrow()
    }
  })

  test("bounds document bytes and source rows before import", async () => {
    const oversized = JSON.stringify({ tokens: { access_token: "a", account_id: "acct", padding: "x".repeat(1024 * 1024) } })
    await expect(previewCodexJson(oversized)).rejects.toThrow(/too large/)
    const rows = JSON.stringify({ accounts: Array.from({ length: 101 }, () => ({ credentials: {} })) })
    await expect(previewCodexJson(rows)).rejects.toThrow(/too many accounts/)
  })

  test("bad candidate shape and malformed JWT claims remain isolated to the selected row", async () => {
    const raw = JSON.stringify({ accounts: [
      null,
      { name: "wrong credentials", credentials: "secret-shape" },
      { name: "bad JWT", credentials: { access_token: jwt({ exp: "secret-exp" }), account_id: "acct-1" } },
      { name: "good", credentials: { access_token: "safe", account_id: "acct-2" } },
    ] })
    const rows = await previewCodexJson(raw)
    expect(rows.map(row => [row.sourceIndex, row.importable])).toEqual([[0, false], [1, false], [2, false], [3, true]])
    expect(JSON.stringify(rows)).not.toContain("secret-shape")
    expect(JSON.stringify(rows)).not.toContain("secret-exp")
    expect((await importCodexFromJson(raw, 3)).config.accounts[0]?.chatgptAccountId).toBe("acct-2")
  })

  test("OAuth callback validates access-token identity and uses issued lifetime", async () => {
    const idToken = accountClaims("acct-1")
    const before = Date.now()
    const valid = await importCodexFromCallback({ code: "code", codeVerifier: "verifier", fetcher: async () =>
      Response.json({ access_token: "opaque", refresh_token: "refresh", id_token: idToken, expires_in: 3600 }) })
    expect(valid.state.accounts[0]?.accessToken?.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
    await expect(importCodexFromCallback({ code: "code", codeVerifier: "verifier", fetcher: async () =>
      Response.json({ access_token: accountClaims("other-account"), refresh_token: "refresh", id_token: idToken, expires_in: 3600 }) }))
      .rejects.toThrow(/account IDs conflict/)
  })

  test.each([
    ["tokens/root", { platform: "anthropic", tokens: { access_token: "foreign", account_id: "acct" } }],
    ["tokens/body", { tokens: { type: "api_key", access_token: "foreign", account_id: "acct" } }],
    ["credentials/root", { type: "api_key", credentials: { access_token: "foreign", account_id: "acct" } }],
    ["credentials/body", { credentials: { platform: "anthropic", access_token: "foreign", account_id: "acct" } }],
    ["accounts/root", { platform: "anthropic", accounts: [{ credentials: { access_token: "foreign", account_id: "acct" } }] }],
    ["accounts/row", { accounts: [{ type: "api_key", credentials: { access_token: "foreign", account_id: "acct" } }] }],
    ["nested/data", { data: { platform: "anthropic", accounts: [{ credentials: { access_token: "foreign", account_id: "acct" } }] } }],
    ["nested/body", { data: { accounts: [{ credentials: { type: "api_key", access_token: "foreign", account_id: "acct" } }] } }],
    ["flat", { type: "api_key", access_token: "foreign", account_id: "acct" }],
  ] as const)("filters explicitly foreign provider/auth tags in %s", async (_name, document) => {
    const raw = JSON.stringify(document)
    expect(await previewCodexJson(raw)).toEqual([])
    await expect(importCodexFromJson(raw, 0)).rejects.toThrow(/unavailable/)
  })

  test("tagged multi-account filtering preserves original source indexes", async () => {
    const raw = JSON.stringify({ accounts: [
      { platform: "anthropic", credentials: { access_token: "foreign", account_id: "acct-0" } },
      { platform: "openai", type: "oauth", credentials: { access_token: "valid", account_id: "acct-1" } },
    ] })
    expect((await previewCodexJson(raw)).map(row => row.sourceIndex)).toEqual([1])
    await expect(importCodexFromJson(raw, 0)).rejects.toThrow(/unavailable/)
    expect((await importCodexFromJson(raw, 1)).config.accounts[0]?.chatgptAccountId).toBe("acct-1")
  })
})
