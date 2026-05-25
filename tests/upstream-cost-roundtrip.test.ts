import { test, expect, describe } from "bun:test"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"

describe("upstream + cost_json roundtrip (sqlite)", () => {
  test("record persists upstream and cost_json", async () => {
    const repo = new SqliteRepo(new Database(":memory:"))
    const hour = "2026-05-25T10"
    const cost = JSON.stringify({ usd: 0.123 })

    await repo.usage.record("k1", "gpt-4", hour, 1, 100, 50, "cli", 0, 0, "copilot:42", cost)

    const rows = await repo.usage.query({ keyId: "k1", start: "2026-05-25T00", end: "2026-05-25T23" })
    expect(rows).toHaveLength(1)
    expect(rows[0].upstream).toBe("copilot:42")
    expect(rows[0].costJson).toBe(cost)
    expect(rows[0].inputTokens).toBe(100)
    expect(rows[0].outputTokens).toBe(50)
  })

  test("conflict index treats different upstream as separate rows", async () => {
    const repo = new SqliteRepo(new Database(":memory:"))
    const hour = "2026-05-25T10"

    await repo.usage.record("k1", "gpt-4", hour, 1, 100, 50, "cli", 0, 0, "copilot:42", null)
    await repo.usage.record("k1", "gpt-4", hour, 1, 200, 80, "cli", 0, 0, "copilot:99", null)

    const rows = await repo.usage.query({ keyId: "k1", start: "2026-05-25T00", end: "2026-05-25T23" })
    expect(rows).toHaveLength(2)
    const byUpstream = new Map(rows.map((r) => [r.upstream, r]))
    expect(byUpstream.get("copilot:42")?.inputTokens).toBe(100)
    expect(byUpstream.get("copilot:99")?.inputTokens).toBe(200)
  })

  test("null upstream rows aggregate together via COALESCE", async () => {
    const repo = new SqliteRepo(new Database(":memory:"))
    const hour = "2026-05-25T10"

    await repo.usage.record("k1", "gpt-4", hour, 1, 100, 50, "cli", 0, 0, null, null)
    await repo.usage.record("k1", "gpt-4", hour, 1, 30, 20, "cli", 0, 0, null, null)

    const rows = await repo.usage.query({ keyId: "k1", start: "2026-05-25T00", end: "2026-05-25T23" })
    expect(rows).toHaveLength(1)
    expect(rows[0].requests).toBe(2)
    expect(rows[0].inputTokens).toBe(130)
    expect(rows[0].outputTokens).toBe(70)
  })

  test("cost_json is preserved on conflict update when later record passes null", async () => {
    const repo = new SqliteRepo(new Database(":memory:"))
    const hour = "2026-05-25T10"
    const cost = JSON.stringify({ usd: 0.5 })

    await repo.usage.record("k1", "gpt-4", hour, 1, 100, 50, "cli", 0, 0, "copilot:42", cost)
    await repo.usage.record("k1", "gpt-4", hour, 1, 10, 5, "cli", 0, 0, "copilot:42", null)

    const rows = await repo.usage.query({ keyId: "k1", start: "2026-05-25T00", end: "2026-05-25T23" })
    expect(rows).toHaveLength(1)
    expect(rows[0].requests).toBe(2)
    expect(rows[0].costJson).toBe(cost)
  })

  test("migrate is idempotent — re-running SqliteRepo on the same db does not throw", () => {
    const db = new Database(":memory:")
    expect(() => new SqliteRepo(db)).not.toThrow()
    expect(() => new SqliteRepo(db)).not.toThrow()
    expect(() => new SqliteRepo(db)).not.toThrow()
  })

  test("github_accounts roundtrip preserves enabled/sortOrder/flagOverrides", async () => {
    const repo = new SqliteRepo(new Database(":memory:"))
    await repo.github.saveAccount(42, {
      token: "tok",
      accountType: "individual",
      user: { id: 42, login: "alice", name: "Alice", avatar_url: null },
      ownerId: "u1",
      enabled: false,
      sortOrder: 7,
      flagOverrides: { web_search: true, foo: false },
    })
    const acct = await repo.github.getAccount(42, "u1")
    expect(acct).not.toBeNull()
    expect(acct?.enabled).toBe(false)
    expect(acct?.sortOrder).toBe(7)
    expect(acct?.flagOverrides).toEqual({ web_search: true, foo: false })
    expect(acct?.updatedAt).toBeTruthy()
  })
})
