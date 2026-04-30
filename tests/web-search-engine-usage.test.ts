import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { setRepoForTest, getRepo } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"

beforeEach(() => {
  const db = new Database(":memory:")
  setRepoForTest(new SqliteRepo(db))
})

describe("web_search_engine_usage", () => {
  test("aggregates per-engine attempts with success/failure/empty/duration", async () => {
    const repo = getRepo()
    const hour = "2026-04-30T12"
    const start = "2026-04-30T00"
    const end = "2026-05-01T00"

    await repo.webSearchEngineUsage.record("k1", "msGrounding", hour, { ok: false, resultCount: 0, durationMs: 250 })
    await repo.webSearchEngineUsage.record("k1", "bing", hour, { ok: true, resultCount: 5, durationMs: 800 })
    await repo.webSearchEngineUsage.record("k1", "bing", hour, { ok: true, resultCount: 0, durationMs: 600 })

    const rows = await repo.webSearchEngineUsage.query({ keyId: "k1", start, end })
    const byEngine = new Map(rows.map((r) => [r.engineId, r]))

    const ms = byEngine.get("msGrounding")
    expect(ms).toBeDefined()
    expect(ms!.attempts).toBe(1)
    expect(ms!.failures).toBe(1)
    expect(ms!.successes).toBe(0)
    expect(ms!.emptyResults).toBe(0)
    expect(ms!.totalDurationMs).toBe(250)

    const bing = byEngine.get("bing")
    expect(bing).toBeDefined()
    expect(bing!.attempts).toBe(2)
    expect(bing!.successes).toBe(2)
    expect(bing!.failures).toBe(0)
    expect(bing!.emptyResults).toBe(1)
    expect(bing!.totalResults).toBe(5)
    expect(bing!.totalDurationMs).toBe(1400)
  })
})
