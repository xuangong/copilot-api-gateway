/**
 * Every GitHub call a Copilot account makes is addressed to that account's own
 * host: github.com → github.com / api.github.com, a GHE.com tenant
 * SUBDOMAIN.ghe.com → SUBDOMAIN.ghe.com / api.SUBDOMAIN.ghe.com. Sending a
 * tenant token to github.com fails and leaks the token to the wrong instance,
 * which is what the gateway's quota and account routes did before these calls
 * moved here. Each call also goes through the injected fetcher, so a
 * proxy-only deployment reaches GitHub through its proxy chain.
 */
import { afterEach, expect, test } from "bun:test"
import type { Fetcher } from "@vibe-core/upstream"
import {
  detectCopilotAccountType,
  exchangeCopilotToken,
  fetchCopilotUser,
  fetchGithubUser,
  normalizeGitHubHost,
  pollGithubDeviceToken,
  requestGithubDeviceCode,
} from "../github"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function recorder(body: unknown = {}, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher: Fetcher = async (url, init) => { calls.push({ url: String(url), init }); return json(body, status) }
  return { calls, fetcher }
}

// Fail loudly if any call bypasses the injected fetcher.
function forbidGlobalFetch() {
  globalThis.fetch = Object.assign(async () => { throw new Error("global fetch must not be used") }, realFetch)
}

const HOSTS = [
  [undefined, "https://github.com", "https://api.github.com"],
  ["github.com", "https://github.com", "https://api.github.com"],
  ["acme.ghe.com", "https://acme.ghe.com", "https://api.acme.ghe.com"],
] as const

const CALLS: Array<[string, (host: string | undefined, f: Fetcher) => Promise<unknown>, "web" | "api", string]> = [
  ["fetchGithubUser", (host, f) => fetchGithubUser("gho_t", host, f), "api", "/user"],
  ["fetchCopilotUser", (host, f) => fetchCopilotUser("gho_t", host, f), "api", "/copilot_internal/user"],
  ["exchangeCopilotToken", (host, f) => exchangeCopilotToken("gho_t", host, f), "api", "/copilot_internal/v2/token"],
  ["detectCopilotAccountType", (host, f) => detectCopilotAccountType("gho_t", host, f), "api", "/copilot_internal/user"],
  ["requestGithubDeviceCode", (host, f) => requestGithubDeviceCode(host ?? "github.com", f), "web", "/login/device/code"],
  ["pollGithubDeviceToken", (host, f) => pollGithubDeviceToken(host ?? "github.com", "dc", f), "web", "/login/oauth/access_token"],
]

for (const [host, web, api] of HOSTS) {
  test.each(CALLS)(`%s for host ${host ?? "(unset)"} goes to that host through the injected fetcher`, async (_name, call, plane, path) => {
    forbidGlobalFetch()
    const { calls, fetcher } = recorder({ token: "t", expires_at: 1 })
    await call(host, fetcher)
    expect(calls.map(c => c.url)).toEqual([`${plane === "web" ? web : api}${path}`])
  })
}

test("GitHub hosts other than github.com and a *.ghe.com tenant are refused before any request", async () => {
  for (const bad of ["evil.example.com", "ghe.com", "a.b.ghe.com", "api.github.com"]) {
    expect(() => normalizeGitHubHost(bad)).toThrow()
    const { calls, fetcher } = recorder()
    await expect(fetchGithubUser("gho_t", bad, fetcher)).rejects.toThrow()
    expect(calls).toEqual([])
  }
  expect(normalizeGitHubHost(" Acme.GHE.com ")).toBe("acme.ghe.com")
})

test("the device code request carries the Copilot client id and scope", async () => {
  const { calls, fetcher } = recorder()
  await requestGithubDeviceCode("acme.ghe.com", fetcher)
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ client_id: "Iv1.b507a08c87ecfe98", scope: "read:user" })
})

test("a failed token exchange throws with the upstream status and body", async () => {
  const { fetcher } = recorder({ message: "Not Found" }, 404)
  await expect(exchangeCopilotToken("gho_t", "github.com", fetcher)).rejects.toThrow(/\(404\).*Not Found/)
})

// detectCopilotAccountType is best-effort metadata (the data-plane host comes
// from the token exchange's endpoints.api); unreadable plans fall back to
// "individual" on purpose rather than failing the login.
test.each([
  ["a business plan", async () => json({ copilot_plan: "business" }), "business"],
  ["an enterprise plan", async () => json({ copilot_plan: "enterprise" }), "enterprise"],
  ["an unknown plan", async () => json({ copilot_plan: "free_limited" }), "individual"],
  ["a non-2xx answer", async () => json({}, 401), "individual"],
  ["an unreachable proxy", async () => { throw new Error("proxy unreachable") }, "individual"],
] as const)("account type for %s", async (_label, respond, expected) => {
  forbidGlobalFetch()
  expect(await detectCopilotAccountType("gho_t", "github.com", respond as Fetcher)).toBe(expected)
})
