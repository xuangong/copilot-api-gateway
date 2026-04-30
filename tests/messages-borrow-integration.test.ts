import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { setRepoForTest, getRepo } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import { resolveWebSearchKeys, invalidateResolverCache } from "~/services/web-search/resolver"

beforeEach(() => {
  const db = new Database(":memory:")
  setRepoForTest(new SqliteRepo(db))
  invalidateResolverCache()
})

describe("messages.ts inline path uses resolveWebSearchKeys", () => {
  test("borrowed langsearch key is resolved at request time", async () => {
    const repo = getRepo()
    const sourceId = "k_src"
    await repo.apiKeys.save({
      id: sourceId,
      name: "src",
      key: "raw-src",
      createdAt: new Date().toISOString(),
      ownerId: "u1",
      webSearchEnabled: true,
      webSearchLangsearchKey: "real-secret",
    })
    const borrowerId = "k_brw"
    await repo.apiKeys.save({
      id: borrowerId,
      name: "brw",
      key: "raw-brw",
      createdAt: new Date().toISOString(),
      ownerId: "u1",
      webSearchEnabled: true,
      webSearchLangsearchRef: sourceId,
    })

    const borrower = (await repo.apiKeys.getById(borrowerId))!
    const resolved = await resolveWebSearchKeys(borrower)
    expect(resolved.langsearchKey).toBe("real-secret")
  })

  test("source revoked between writes makes the key undefined", async () => {
    const repo = getRepo()
    const sourceId = "k_src2"
    await repo.apiKeys.save({
      id: sourceId,
      name: "src",
      key: "raw-src",
      createdAt: new Date().toISOString(),
      ownerId: "u1",
      webSearchEnabled: true,
      webSearchLangsearchKey: "real-secret",
    })
    const borrowerId = "k_brw2"
    await repo.apiKeys.save({
      id: borrowerId,
      name: "brw",
      key: "raw-brw",
      createdAt: new Date().toISOString(),
      ownerId: "u2",
      webSearchEnabled: true,
      webSearchLangsearchRef: sourceId,
    })

    // u2 has access via assignment; confirm key is visible
    await repo.keyAssignments.assign(sourceId, "u2", "u1")
    const borrowerBefore = (await repo.apiKeys.getById(borrowerId))!
    expect(
      (await resolveWebSearchKeys(borrowerBefore, undefined, { skipCache: true })).langsearchKey,
    ).toBe("real-secret")

    // Revoke the assignment — key should no longer resolve
    await repo.keyAssignments.unassign(sourceId, "u2")
    const borrowerAfter = (await repo.apiKeys.getById(borrowerId))!
    expect(
      (await resolveWebSearchKeys(borrowerAfter, undefined, { skipCache: true })).langsearchKey,
    ).toBeUndefined()
  })
})
