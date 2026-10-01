import { expect, test } from "bun:test"
import { selectLatestDumpSnapshot, DUMP_LIVE_QUEUE_POLICY } from "../src/shared/dump/live-policy.ts"
import { DumpStreamPermits } from "../src/shared/dump/stream-permits.ts"
import { encodedFrameCharge } from "../src/shared/runtime/channel-broker-contract.ts"
import type { DumpMetadata } from "../src/shared/dump/types.ts"
const row = (id: string, path = "/"): DumpMetadata => ({ id, path, method: "POST", startedAt: 0, completedAt: 1,
  status: 200, upstream: null, model: null, inputTokens: null, outputTokens: null, requestBytes: 0,
  responseBytes: 0, durationMs: 1, error: null })

test("snapshot admits newest fitting rows at exact charge and records omissions without mutating metadata", () => {
  const first = row("newest")
  const oversized = row("oversized", "x".repeat(10000))
  const last = row("older")
  const input = [first, oversized, last]
  const before = JSON.stringify(input)
  const envelopeCharge = encodedFrameCharge(JSON.stringify({ records: [], view: "latest", limit: 100,
    omittedRows: 3, completeHistory: false, hasMore: false, before: "older" }))
  const maxQueueBytes = envelopeCharge + encodedFrameCharge(JSON.stringify(first)) + encodedFrameCharge(JSON.stringify(last))
  const snapshot = selectLatestDumpSnapshot(input, { ...DUMP_LIVE_QUEUE_POLICY, maxQueueBytes })
  expect(snapshot).toEqual({ records: [first, last], view: "latest", limit: 100, omittedRows: 1, completeHistory: false, hasMore: false, before: "older" })
  expect(JSON.stringify(input)).toBe(before)
  expect(selectLatestDumpSnapshot(input, { ...DUMP_LIVE_QUEUE_POLICY, maxQueueBytes: maxQueueBytes - 1 }).records).toEqual([first])
})

test("stream permit admission is immediate with exact key/isolate boundaries and idempotent retirement", () => {
  const permits = new DumpStreamPermits()
  const held: Array<() => void> = []
  for (let key = 0; key < 4; key++) {
    for (let i = 0; i < 4; i++) {
      const release = permits.acquire(`k${key}`)
      if (!release) throw new Error("unexpected saturation")
      held.push(release)
    }
    expect(permits.acquire(`k${key}`)).toBeNull()
  }
  expect(permits.acquire("other")).toBeNull()
  held[0]?.()
  held[0]?.()
  const replacement = permits.acquire("other")
  expect(replacement).not.toBeNull()
  expect(permits.acquire("other")).toBeNull()
  for (const release of held) release()
  replacement?.()
  expect(permits.acquire("fresh")).not.toBeNull()
})


test("all omitted latest rows retain SQL pagination and the whole encoded envelope is bounded", () => {
  const rows = Array.from({ length: 100 }, (_, index) => row(`cursor-${index}`, "x".repeat(10000)))
  const snapshot = selectLatestDumpSnapshot(rows)
  expect(snapshot.records).toEqual([])
  expect(snapshot.omittedRows).toBe(100)
  expect(snapshot.before).toBe("cursor-99")
  expect(snapshot.hasMore).toBe(true)
  expect(encodedFrameCharge(JSON.stringify(snapshot))).toBeLessThanOrEqual(DUMP_LIVE_QUEUE_POLICY.maxQueueBytes)
  expect(() => selectLatestDumpSnapshot([row("x".repeat(200000))])).toThrow("queue_bytes")
})
