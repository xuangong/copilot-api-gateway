import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { getAuthoritativeUpstreamRepo } from "@vibe-core/upstream-repo"
import { initRepo, getDataPlaneConfiguration } from "../src/repo/index.ts"
import { upstreamsRouter, type AuthCtx } from "../src/control-plane/upstreams/routes.ts"
import { addGithubAccount, copilotUpstreamRowId } from "../src/control-plane/lib/github.ts"
import type { GitHubUser, UpstreamRecord } from "../src/repo/types.ts"

const SECRET = "SYNTHETIC_PRIVATE_TOKEN_123"
const resources: Array<() => void> = []
afterEach(() => { __resetPlatformForTests(); for (const close of resources.splice(0)) close() })

function fixture(auth: AuthCtx = { isAdmin: true, userId: "owner" }) {
  __resetPlatformForTests()
  const dir = mkdtempSync(join(tmpdir(), "upstream-dto-"))
  const a = new Database(join(dir, "test.sqlite"))
  const repo = new BunSqliteRepo(a)
  const b = new Database(join(dir, "test.sqlite"))
  const sibling = new BunSqliteRepo(b)
  resources.push(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) })
  initRepo(repo)
  const app = new Hono()
  app.use("*", (c, next) => { c.set("auth", auth); return next() })
  app.route("/api/upstreams", upstreamsRouter)
  return { repo, sibling, app, b }
}

const configs = {
  copilot: { githubToken: SECRET, accountType: "individual", githubHost: "github.com", source: "paste", user: { id: 42, login: "octo", name: "Octo", avatar_url: "https://example.test/avatar" } },
  azure: { name: "azure", endpoint: "https://example.openai.azure.com", apiKey: SECRET, deployment: "one", apiVersion: "2024-01-01", endpoints: ["chat_completions"], defaultHeaders: { Authorization: SECRET } },
  custom: { name: "custom", baseUrl: "https://example.test", apiKey: SECRET, authStyle: "bearer", endpoints: ["responses"], defaultHeaders: { Authorization: SECRET }, models: [{ id: "one", chat: { reasoning: { budget_tokens: { min: 1, max: 2048 } } } }] },
  sdf: { name: "sdf", substrateToken: SECRET, taxonomy: { experience: "BizChat", agent: "agent" }, cos: { serviceTier: "default" }, passport: { apiBase: "https://example.test" } },
  codex: { accounts: [{ email: "example@test.invalid", chatgptAccountId: "account", chatgptUserId: "user", planType: "pro" }] },
  "claude-code": { accounts: [{ email: null, accountUuid: "uuid", organizationUuid: null, subscriptionType: "pro", rateLimitTier: "default" }] },
} satisfies Record<string, Record<string, unknown>>

function upstream(provider: keyof typeof configs = "custom"): UpstreamRecord<unknown> {
  return {
    id: `up_${provider}`, ownerId: "owner", provider, name: provider, enabled: true, sortOrder: 7,
    config: { ...configs[provider], surprise: SECRET }, flagOverrides: {}, disabledPublicModelIds: ["hidden"],
    proxyFallbackList: [{ id: "direct_fetch", colos: ["LAX"] }],
    state: { accessToken: SECRET, refresh_token: SECRET, id_token: SECRET, nested: { unknown: SECRET } },
    createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z",
  }
}

const json = (body: unknown, method = "PATCH"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

test("all provider list and metadata PATCH DTOs omit private state and internal identity", async () => {
  const { repo, app } = fixture()
  for (const provider of Object.keys(configs) as Array<keyof typeof configs>) await repo.upstreams.save(upstream(provider))
  const listed = await app.request("/api/upstreams?includeDisabled=1")
  expect(listed.status).toBe(200)
  const text = await listed.text()
  expect(text).not.toContain(SECRET)
  const rows = (JSON.parse(text) as { upstreams: Array<Record<string, unknown>> }).upstreams
  for (const row of rows) {
    expect(row).not.toHaveProperty("state")
    expect(row).not.toHaveProperty("rowIncarnation")
    expect(row).toMatchObject({ sortOrder: 7, disabledPublicModelIds: ["hidden"], proxyFallbackList: [{ id: "direct_fetch", colos: ["LAX"] }] })
    const response = await app.request(`/api/upstreams/${String(row.id)}`, json({ name: "edited" }))
    expect(response.status).toBe(200)
    const patched = await response.text()
    expect(patched).not.toContain(SECRET)
    expect(JSON.parse(patched).upstream).not.toHaveProperty("state")
    expect(JSON.parse(patched).upstream).not.toHaveProperty("rowIncarnation")
  }
  expect(rows.find(row => row.provider === "copilot")?.config).toMatchObject({ user: configs.copilot.user, githubToken: "***" })
  expect(rows.find(row => row.provider === "custom")?.config).toMatchObject({ models: configs.custom.models })
  expect(rows.find(row => row.provider === "codex")?.config).toEqual(configs.codex)
})

test("create responses retain editable safe config while redacted roundtrips preserve header credentials", async () => {
  const { repo, app } = fixture()
  for (const provider of ["copilot", "azure", "custom", "sdf"] as const) {
    const response = await app.request("/api/upstreams", json({ provider, name: provider, config: configs[provider] }, "POST"))
    expect(response.status).toBe(201)
    const text = await response.text()
    expect(text).not.toContain(SECRET)
    const { upstream: created } = JSON.parse(text) as { upstream: { id: string; config: Record<string, unknown> } }
    expect(created).not.toHaveProperty("state")
    if (provider === "copilot") continue
    const patched = await app.request(`/api/upstreams/${created.id}`, json({ config: created.config }))
    expect(patched.status).toBe(200)
    const stored = await repo.upstreams.getById(created.id)
    if (provider === "custom" || provider === "azure") expect(stored?.config.defaultHeaders).toEqual({ Authorization: SECRET })
  }
})

test("PATCH rebases latest metadata and never restores the private state from its authorization read", async () => {
  const { repo, sibling, app } = fixture()
  await repo.upstreams.save(upstream())
  const read = repo.upstreams.getById.bind(repo.upstreams)
  let interleaved = false
  repo.upstreams.getById = async id => {
    const old = await read(id)
    if (!interleaved) {
      interleaved = true
      await sibling.upstreams.saveState(id, () => ({ quota: 19, accessToken: "rotated" }))
      const latest = await sibling.upstreams.getById(id)
      if (!latest) throw new Error("fixture absent")
      await sibling.upstreams.patchMetadata(latest, current => ({ ...current, sortOrder: 88 }))
    }
    return old
  }
  expect((await app.request("/api/upstreams/up_custom", json({ name: "edited" }))).status).toBe(200)
  expect(await sibling.upstreams.getById("up_custom")).toMatchObject({ name: "edited", sortOrder: 88, state: { quota: 19, accessToken: "rotated" } })
})

test("PATCH owner changes after authorization remain indistinguishable from missing rows", async () => {
  const { repo, app, b } = fixture({ userId: "owner", isUser: true })
  await repo.upstreams.save(upstream())
  const read = repo.upstreams.getById.bind(repo.upstreams)
  repo.upstreams.getById = async id => {
    const old = await read(id)
    b.query("UPDATE upstreams SET owner_id = ? WHERE id = ?").run("other", id)
    return old
  }
  expect((await app.request("/api/upstreams/up_custom", json({ name: "hijacked" }))).status).toBe(404)
  expect((await app.request("/api/upstreams/missing", json({ name: "hijacked" }))).status).toBe(404)
})

test("list/create/PATCH reject unauthenticated and foreign owner access", async () => {
  const { repo, app } = fixture({})
  await repo.upstreams.save(upstream())
  expect((await app.request("/api/upstreams")).status).toBe(403)
  expect((await app.request("/api/upstreams", json({ provider: "custom", name: "x", config: configs.custom }, "POST"))).status).toBe(403)
  expect((await app.request("/api/upstreams/up_custom", json({ name: "x" }))).status).toBe(404)
})

test("validator failures never echo secret values or unknown object keys", async () => {
  const { app, repo } = fixture()
  await repo.upstreams.save(upstream())
  for (const body of [
    { provider: SECRET, name: "x", config: configs.custom },
    { provider: "custom", name: "x", config: { ...configs.custom, endpoints: [SECRET] } },
    { provider: "custom", name: "x", flagOverrides: { [SECRET]: true }, config: configs.custom },
    { provider: "custom", name: "x", config: { ...configs.custom, defaultHeaders: { [SECRET]: 123 } } },
    { provider: "custom", name: "x", config: { ...configs.custom, defaultHeaders: { [`private\n${SECRET}`]: 123 } } },
    { provider: "custom", name: "x", config: { ...configs.custom, models: [{ upstreamModelId: "one", cost: { [SECRET]: 1 } }] } },
  ]) {
    const response = await app.request("/api/upstreams", json(body, "POST"))
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(SECRET)
    const patch = await app.request("/api/upstreams/up_custom", json(body))
    expect(patch.status).toBe(400)
    expect(await patch.text()).not.toContain(SECRET)
  }
})

test("storage failures do not echo driver messages or submitted credentials", async () => {
  const { app, repo, b } = fixture()
  await repo.upstreams.save(upstream())
  b.exec(`CREATE TRIGGER reject_upstream BEFORE INSERT ON upstreams BEGIN SELECT RAISE(ABORT, '${SECRET}'); END`)
  b.exec(`CREATE TRIGGER reject_upstream_update BEFORE UPDATE ON upstreams BEGIN SELECT RAISE(ABORT, '${SECRET}'); END`)
  const response = await app.request("/api/upstreams", json({ provider: "custom", name: "x", config: configs.custom }, "POST"))
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain(SECRET)
  const patch = await app.request("/api/upstreams/up_custom", json({ name: "edited" }))
  expect(patch.status).toBe(500)
  expect(await patch.text()).not.toContain(SECRET)
})

const user: GitHubUser = { id: 42, login: "octo", name: "Octo", avatar_url: "https://example.test/avatar" }
for (const ownerId of ["owner", undefined]) {
  test(`Copilot reauthorization preserves concurrent state and metadata (${ownerId ?? "global"})`, async () => {
    const { repo, sibling } = fixture()
    await addGithubAccount("old", user, "individual", ownerId)
    const id = copilotUpstreamRowId(ownerId ?? "", user.id)
    const read = repo.upstreams.getById.bind(repo.upstreams)
    let interleaved = false
    repo.upstreams.getById = async key => {
      const old = await read(key)
      if (!interleaved) {
        interleaved = true
        await sibling.upstreams.saveState(key, () => ({ quota: 9, fresh: true }))
        const latest = await sibling.upstreams.getById(key)
        if (!latest) throw new Error("fixture absent")
        await sibling.upstreams.patchMetadata(latest, current => ({ ...current, name: "edited", enabled: false }))
      }
      return old
    }
    await addGithubAccount("new", user, "individual", ownerId, { copilotApiEndpoint: "https://copilot.example.test" })
    expect(await sibling.upstreams.getById(id)).toMatchObject({ name: "edited", enabled: false, config: { githubToken: "new" }, state: { quota: 9, fresh: true, copilotApiEndpoint: "https://copilot.example.test" } })
  })
}

test("a first Copilot create race cannot overwrite another owner's row", async () => {
  const { repo, sibling } = fixture()
  const read = repo.upstreams.getById.bind(repo.upstreams)
  repo.upstreams.getById = async id => {
    const old = await read(id)
    if (!old) await sibling.upstreams.save({ ...upstream("copilot"), id, ownerId: "other" })
    return old
  }
  await expect(addGithubAccount("new", user, "individual", "owner")).rejects.toMatchObject({ name: "UpstreamReplacedError" })
  expect((await sibling.upstreams.getById(copilotUpstreamRowId("owner", user.id)))?.ownerId).toBe("other")
})

test("metadata mutations invalidate configuration views and authoritative state reads refresh them", async () => {
  const { repo, sibling } = fixture()
  const stored = await repo.upstreams.createIfAbsent(upstream())
  if (!stored) throw new Error("fixture absent")
  const view = getDataPlaneConfiguration()
  expect((await view.upstreams.getById(stored.id))?.name).toBe("custom")
  await repo.upstreams.patchMetadata(stored, row => ({ ...row, name: "new" }))
  expect((await view.upstreams.getById(stored.id))?.name).toBe("new")
  await sibling.upstreams.saveState(stored.id, () => ({ latest: true }))
  const authoritative = await getAuthoritativeUpstreamRepo().getById(stored.id)
  expect(authoritative?.rowIncarnation).toBe(stored.rowIncarnation)
  expect(authoritative?.state).toEqual({ latest: true })
  expect((await view.upstreams.getById(stored.id))?.state).toEqual({ latest: true })
})

test("concurrent config PATCH requests rebase disjoint edits without losing credentials", async () => {
  const { repo, app, sibling } = fixture({ isUser: true, userId: "owner" })
  await repo.upstreams.save(upstream())
  const responses = await Promise.all([
    app.request("/api/upstreams/up_custom", json({ config: { baseUrl: "https://changed.test" } })),
    app.request("/api/upstreams/up_custom", json({ config: { modelsEndpoint: "https://models.test", apiKey: "***" } })),
  ])
  expect(responses.map(response => response.status)).toEqual([200, 200])
  expect((await sibling.upstreams.getById("up_custom"))?.config).toMatchObject({ baseUrl: "https://changed.test", modelsEndpoint: "https://models.test", apiKey: SECRET })
})

test("Copilot existing-row reauthorization rejects owner transfer between read and write", async () => {
  const { repo, sibling, b } = fixture()
  await addGithubAccount("old", user, "individual", "owner")
  const id = copilotUpstreamRowId("owner", user.id)
  const read = repo.upstreams.getById.bind(repo.upstreams)
  repo.upstreams.getById = async key => {
    const old = await read(key)
    b.query("UPDATE upstreams SET owner_id = ? WHERE id = ?").run("other", key)
    return old
  }
  await expect(addGithubAccount("new", user, "individual", "owner")).rejects.toMatchObject({ name: "UpstreamReplacedError" })
  expect(await sibling.upstreams.getById(id)).toMatchObject({ ownerId: "other", config: { githubToken: "old" } })
})

test("a Copilot create race with the same owner keeps the winner's state and metadata", async () => {
  const { repo, sibling } = fixture()
  const read = repo.upstreams.getById.bind(repo.upstreams)
  repo.upstreams.getById = async id => {
    const old = await read(id)
    if (!old) await sibling.upstreams.save({ ...upstream("copilot"), id, name: "winner", state: { quota: 99 } })
    return old
  }
  await addGithubAccount("new", user, "individual", "owner")
  expect(await sibling.upstreams.getById(copilotUpstreamRowId("owner", user.id)))
    .toMatchObject({ name: "winner", state: { quota: 99 }, config: { githubToken: "new" } })
})

test("admin may edit another owner while regular users cannot list or PATCH it", async () => {
  const { repo, app } = fixture()
  await repo.upstreams.save({ ...upstream(), ownerId: "other" })
  expect((await app.request("/api/upstreams/up_custom", json({ name: "admin-edit" }))).status).toBe(200)
  const userApp = new Hono()
  userApp.use("*", (c, next) => { c.set("auth", { isUser: true, userId: "owner" }); return next() })
  userApp.route("/api/upstreams", upstreamsRouter)
  expect(await (await userApp.request("/api/upstreams")).json()).toEqual({ upstreams: [] })
  expect((await userApp.request("/api/upstreams/up_custom", json({ name: "foreign" }))).status).toBe(404)
  const created = await userApp.request("/api/upstreams", json({ provider: "custom", name: "own", ownerId: "other", config: configs.custom }, "POST"))
  expect(created.status).toBe(201)
  expect((await created.json() as { upstream: { ownerId: string } }).upstream.ownerId).toBe("owner")
})
