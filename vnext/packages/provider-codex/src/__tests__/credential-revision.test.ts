import { expect, test } from "bun:test"
import { importCodexFromAuthJson, importCodexFromCallback } from "../auth/import"
import { readCodexUpstreamState } from "../state"

const identity = `header.${btoa(JSON.stringify({ email: "fixture@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "account", chatgpt_user_id: "user", chatgpt_plan_type: "plus" } }))}.signature`
const tokens = { access_token: "access", refresh_token: "refresh", id_token: identity, expires_in: 3600 }

test("both import constructors mint a distinct persisted credential revision", async () => {
  const imports = [
    await importCodexFromAuthJson(JSON.stringify({ tokens })),
    await importCodexFromAuthJson(JSON.stringify({ tokens })),
    await importCodexFromCallback({ code: "fixture", codeVerifier: "fixture", fetcher: async () => Response.json(tokens) }),
  ]
  const revisions = imports.map(value => value.state.accounts[0]?.credentialRevision)
  for (const revision of revisions) expect(typeof revision === "string" && revision.length > 0).toBe(true)
  expect(new Set(revisions).size).toBe(3)
})

test("legacy state reads preserve absent revision while revision validation rejects empty or non-string values", () => {
  const legacy = { accounts: [{ chatgptAccountId: "account", refresh_token: "refresh", state: "active" as const, state_updated_at: "now", openaiDeviceId: "device", accessToken: null, quotaSnapshot: null }] }
  expect(readCodexUpstreamState(legacy)).toEqual(legacy)
  const account = legacy.accounts[0]
  expect(() => readCodexUpstreamState({ accounts: [{ ...account, credentialRevision: "revision" }] })).not.toThrow()
  for (const credentialRevision of ["", "   ", null, 1]) {
    expect(() => readCodexUpstreamState({ accounts: [{ ...account, credentialRevision }] })).toThrow()
  }
})
