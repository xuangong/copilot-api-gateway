import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { Elysia } from "elysia"
import { setRepoForTest, getRepo } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import { apiKeysRoute } from "~/routes/api-keys"

let app: Elysia

beforeEach(async () => {
  const db = new Database(":memory:")
  setRepoForTest(new SqliteRepo(db))
  app = new Elysia()
    .derive(() => ({ isAdmin: true, userId: "u1" }))
    .use(apiKeysRoute)
})

async function createKey(
  ownerId: string,
  opts: Partial<{ langsearch: string; tavily: string; msGrounding: string }> = {},
) {
  const repo = getRepo()
  const id = "k_" + Math.random().toString(36).slice(2, 8)
  await repo.apiKeys.save({
    id,
    name: id,
    key: "raw-" + id,
    createdAt: new Date().toISOString(),
    ownerId,
    webSearchEnabled: true,
    webSearchLangsearchKey: opts.langsearch,
    webSearchTavilyKey: opts.tavily,
    webSearchMsGroundingKey: opts.msGrounding,
  })
  return id
}

describe("PATCH /api/keys/:id ref fields", () => {
  test("400 when both literal and ref provided for same engine", async () => {
    const sourceId = await createKey("u1", { langsearch: "src" })
    const targetId = await createKey("u1")
    const res = await app.handle(
      new Request(`http://localhost/api/keys/${targetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          web_search_langsearch_key: "lit",
          web_search_langsearch_ref: sourceId,
        }),
      }),
    )
    expect(res.status).toBe(400)
  })

  test("404 when ref source does not exist", async () => {
    const targetId = await createKey("u1")
    const res = await app.handle(
      new Request(`http://localhost/api/keys/${targetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ web_search_langsearch_ref: "k_does_not_exist" }),
      }),
    )
    expect(res.status).toBe(404)
  })

  test("setting ref clears the matching literal", async () => {
    const sourceId = await createKey("u1", { langsearch: "src-secret" })
    const targetId = await createKey("u1", { langsearch: "old-literal" })
    const res = await app.handle(
      new Request(`http://localhost/api/keys/${targetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ web_search_langsearch_ref: sourceId }),
      }),
    )
    expect(res.status).toBe(200)
    const stored = await getRepo().apiKeys.getById(targetId)
    expect(stored?.webSearchLangsearchKey).toBeUndefined()
    expect(stored?.webSearchLangsearchRef).toBe(sourceId)
  })

  test("setting literal clears the matching ref", async () => {
    const sourceId = await createKey("u1", { langsearch: "src" })
    const targetId = await createKey("u1")
    // Manually set a ref on the target
    await getRepo().apiKeys.save({
      ...(await getRepo().apiKeys.getById(targetId))!,
      webSearchLangsearchRef: sourceId,
    })
    const res = await app.handle(
      new Request(`http://localhost/api/keys/${targetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ web_search_langsearch_key: "new-literal" }),
      }),
    )
    expect(res.status).toBe(200)
    const stored = await getRepo().apiKeys.getById(targetId)
    expect(stored?.webSearchLangsearchKey).toBe("new-literal")
    expect(stored?.webSearchLangsearchRef).toBeUndefined()
  })
})

describe("GET /api/keys/:id with ref fields", () => {
  test("borrower never sees source's literal value", async () => {
    const sourceId = await createKey("u1", { langsearch: "supersecret-XYZ" })
    const targetId = await createKey("u1")
    await getRepo().apiKeys.save({
      ...(await getRepo().apiKeys.getById(targetId))!,
      webSearchLangsearchRef: sourceId,
    })
    const res = await app.handle(new Request(`http://localhost/api/keys/${targetId}`))
    const json = (await res.json()) as any
    // GET /:id returns a single object, not array
    const target = Array.isArray(json) ? json.find((k: any) => k.id === targetId) : json
    expect(target.web_search_langsearch_key).toBeNull()
    expect(target.web_search_langsearch_ref).toMatchObject({ id: sourceId })
    expect(target.web_search_langsearch_ref.broken).toBeUndefined()
    expect(JSON.stringify(target)).not.toContain("supersecret-XYZ")
  })

  test("broken ref renders as { broken: true }", async () => {
    const targetId = await createKey("u1")
    await getRepo().apiKeys.save({
      ...(await getRepo().apiKeys.getById(targetId))!,
      webSearchLangsearchRef: "k_deleted",
    })
    const res = await app.handle(new Request(`http://localhost/api/keys/${targetId}`))
    const json = (await res.json()) as any
    const target = Array.isArray(json) ? json.find((k: any) => k.id === targetId) : json
    expect(target.web_search_langsearch_ref).toMatchObject({
      id: "k_deleted",
      name: null,
      owner_id: null,
      broken: true,
    })
  })
})

describe("POST /api/keys/:id/copy-web-search-from/:sourceId", () => {
  test("sets refs, clears literals, preserves flags", async () => {
    const sourceId = await createKey("u1", { langsearch: "src-l", tavily: "src-t" })
    await getRepo().apiKeys.save({
      ...(await getRepo().apiKeys.getById(sourceId))!,
      webSearchPriority: ["msGrounding", "langsearch"],
      webSearchBingEnabled: true,
      webSearchCopilotPriority: true,
    })
    const targetId = await createKey("u1", { langsearch: "old-target-literal" })
    const res = await app.handle(
      new Request(`http://localhost/api/keys/${targetId}/copy-web-search-from/${sourceId}`, {
        method: "POST",
      }),
    )
    expect(res.status).toBe(200)
    const stored = await getRepo().apiKeys.getById(targetId)
    expect(stored?.webSearchLangsearchKey).toBeUndefined()
    expect(stored?.webSearchLangsearchRef).toBe(sourceId)
    expect(stored?.webSearchTavilyRef).toBe(sourceId)
    expect(stored?.webSearchMsGroundingRef).toBeUndefined()
    expect(stored?.webSearchBingEnabled).toBe(true)
    expect(stored?.webSearchCopilotPriority).toBe(true)
    expect(stored?.webSearchPriority).toEqual(["msGrounding", "langsearch"])
  })
})
