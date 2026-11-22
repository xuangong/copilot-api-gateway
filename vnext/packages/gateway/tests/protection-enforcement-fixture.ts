// packages/gateway/tests/protection-enforcement-fixture.ts
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { initBackground, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index.ts"
import { listUpstreamModels } from "../src/data-plane/providers/registry.ts"
import type { UpstreamRecord } from "../src/repo/types.ts"
import type { NewPause } from "../src/repo/protection.ts"
import { ProtectionRuntime, setProtectionForTests } from "../src/protection/runtime.ts"

export const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
let counter = 0
export const pauseId = () => `pp_${(++counter).toString(16).padStart(32, "0")}`

export async function enforcementFixture(ids: readonly string[] = ["up_test_first", "up_test_second"], opts: { ownerId?: string } = {}) {
  initRuntimeLocation("bun")
  initBackground({ waitUntil: () => {} })
  const db = new Database(":memory:")
  const repo = new BunSqliteRepo(db)
  initRepo(repo)
  for (const [index, id] of ids.entries()) {
    const row: UpstreamRecord = { id, ...(opts.ownerId ? { ownerId: opts.ownerId } : {}), provider: "custom", name: id, enabled: true, sortOrder: index,
      config: { name: id, baseUrl: `https://${id}.invalid`, authStyle: "none", endpoints: ["chat_completions", "responses", "embeddings", "alpha_search", "messages_count_tokens"], models: ["shared"] },
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], state: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
    await repo.upstreams.save(row)
  }
  await listUpstreamModels()
  const clock = { now: NOW }
  const runtime = new ProtectionRuntime({ repo: () => repo, now: () => clock.now, schedule: () => {} })
  setProtectionForTests(runtime)
  /** Inserts a pause row straight into the repo (as another isolate would). */
  const pause = async (over: Partial<NewPause> & { targetId: string }): Promise<NewPause> => {
    const row: NewPause = {
      id: pauseId(), targetKind: "upstream", upstreamId: over.targetId, mode: "pause",
      reason: { windowMinutes: 5, requests: 50, risky: 46, counts: { rate_limited: 46, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0.92, topKeys: [], trigger: "ratio", keyShare: null, upstreamName: over.targetId },
      startedAt: NOW, endsAt: NOW + 600_000, ...over,
    }
    await repo.protection.insertPauseIfNone(row, NOW)
    return row
  }
  /** Advances past the cache TTL and lets the background refresh finish, so rows written meanwhile are visible. */
  const tick = async (ms = 10_000): Promise<void> => { clock.now += ms; await runtime.activePauses(); await runtime.whenIdle() }
  return { db, repo, runtime, clock, pause, tick, close: () => db.close() }
}
