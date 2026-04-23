import { test, expect, beforeEach, describe } from "bun:test"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(":memory:"))
})

describe("ObservabilityShareRepo (sqlite)", () => {
  test("share + isGranted true", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    expect(await repo.observabilityShares.isGranted("owner-1", "viewer-1")).toBe(true)
  })

  test("isGranted false when not shared", async () => {
    expect(await repo.observabilityShares.isGranted("owner-1", "viewer-1")).toBe(false)
  })

  test("isGranted is directional (viewer cannot view owner's reverse)", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    expect(await repo.observabilityShares.isGranted("viewer-1", "owner-1")).toBe(false)
  })

  test("share is idempotent", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    const list = await repo.observabilityShares.listByOwner("owner-1")
    expect(list).toHaveLength(1)
  })

  test("unshare removes the grant", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.unshare("owner-1", "viewer-1")
    expect(await repo.observabilityShares.isGranted("owner-1", "viewer-1")).toBe(false)
  })

  test("listByOwner returns all viewers granted by owner", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.share("owner-1", "viewer-2", "owner-1")
    await repo.observabilityShares.share("owner-2", "viewer-1", "owner-2")
    const list = await repo.observabilityShares.listByOwner("owner-1")
    expect(list.map(s => s.viewerId).sort()).toEqual(["viewer-1", "viewer-2"])
  })

  test("listByViewer returns all owners that granted this viewer", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.share("owner-2", "viewer-1", "owner-2")
    await repo.observabilityShares.share("owner-1", "viewer-2", "owner-1")
    const list = await repo.observabilityShares.listByViewer("viewer-1")
    expect(list.map(s => s.ownerId).sort()).toEqual(["owner-1", "owner-2"])
  })

  test("deleteByOwner removes all grants by an owner", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.share("owner-1", "viewer-2", "owner-1")
    await repo.observabilityShares.share("owner-2", "viewer-1", "owner-2")
    await repo.observabilityShares.deleteByOwner("owner-1")
    expect(await repo.observabilityShares.listByOwner("owner-1")).toHaveLength(0)
    expect(await repo.observabilityShares.listByOwner("owner-2")).toHaveLength(1)
  })

  test("deleteByViewer removes all grants to a viewer", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.share("owner-2", "viewer-1", "owner-2")
    await repo.observabilityShares.share("owner-1", "viewer-2", "owner-1")
    await repo.observabilityShares.deleteByViewer("viewer-1")
    expect(await repo.observabilityShares.listByViewer("viewer-1")).toHaveLength(0)
    expect(await repo.observabilityShares.listByViewer("viewer-2")).toHaveLength(1)
  })

  test("grantedAt is an ISO timestamp", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    const [s] = await repo.observabilityShares.listByOwner("owner-1")
    expect(new Date(s.grantedAt).toString()).not.toBe("Invalid Date")
    expect(s.grantedBy).toBe("owner-1")
  })

  test("cascade: deleteByOwner + deleteByViewer together remove all references to a user", async () => {
    await repo.observabilityShares.share("u-1", "u-2", "u-1")
    await repo.observabilityShares.share("u-1", "u-3", "u-1")
    await repo.observabilityShares.share("u-3", "u-1", "u-3")
    await repo.observabilityShares.deleteByOwner("u-1")
    await repo.observabilityShares.deleteByViewer("u-1")
    expect(await repo.observabilityShares.listByOwner("u-1")).toHaveLength(0)
    expect(await repo.observabilityShares.listByViewer("u-1")).toHaveLength(0)
    // u-3's other relationships untouched
    expect(await repo.observabilityShares.listByOwner("u-3")).toHaveLength(0)
  })
})
