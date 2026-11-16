import { expect, test } from "bun:test"
import type { SyncSourceView } from "../../api/sync"
import { PollGate, shouldPoll, sourceChanged, sourceHealth } from "./sync-source"

const source = (over: Partial<SyncSourceView> = {}): SyncSourceView => ({ origin: "https://central.example", deviceId: `sdv_${"1".repeat(32)}`,
  status: "active", lastAttemptAt: null, lastSuccessAt: null, lastError: null, upstreamCount: 0, ...over })

test("every status and error combination maps to one health", () => {
  const ok = "2026-11-16T10:00:00.000Z"
  const codes = [null, "unreachable", "http_error", "bad_response", "apply_failed", "id_conflict", "unsupported_provider", "something_new"]
  const expected = (status: "active" | "revoked", lastError: string | null, lastSuccessAt: string | null) => {
    if (status === "revoked") return "revoked"
    if (lastError === null) return "ok"
    return (lastError === "id_conflict" || lastError === "unsupported_provider") && lastSuccessAt ? "skipped" : "failing"
  }
  for (const status of ["active", "revoked"] as const) for (const lastSuccessAt of [null, ok]) for (const lastError of codes) {
    expect(sourceHealth(source({ status, lastError, lastSuccessAt })), `${status} ${lastError} ${lastSuccessAt}`).toBe(expected(status, lastError, lastSuccessAt))
  }
  // A skip code without any successful run is a failure, not a warning.
  expect(sourceHealth(source({ lastError: "id_conflict", lastSuccessAt: null }))).toBe("failing")
})

test("health separates revoked, failing, partially skipped and fine sources", () => {
  expect(sourceHealth(source())).toBe("ok")
  expect(sourceHealth(source({ status: "revoked" }))).toBe("revoked")
  expect(sourceHealth(source({ status: "revoked", lastError: "unreachable" }))).toBe("revoked")
  for (const lastError of ["unreachable", "http_error", "bad_response", "apply_failed", "something_new"]) expect(sourceHealth(source({ lastError }))).toBe("failing")
  for (const lastError of ["id_conflict", "unsupported_provider"]) expect(sourceHealth(source({ lastError, lastSuccessAt: "2026-11-16T10:00:00.000Z" }))).toBe("skipped")
})

test("a poll that changes status, last success or upstream count means the upstream list is stale", () => {
  const base = source({ lastSuccessAt: "2026-11-16T10:00:00.000Z", upstreamCount: 2 })
  expect(sourceChanged(base, { ...base })).toBe(false)
  expect(sourceChanged(base, { ...base, lastAttemptAt: "2026-11-16T10:05:00.000Z", lastError: "unreachable" })).toBe(false)
  expect(sourceChanged(base, { ...base, status: "revoked" })).toBe(true)
  expect(sourceChanged(base, { ...base, lastSuccessAt: "2026-11-16T10:01:00.000Z" })).toBe(true)
  expect(sourceChanged(base, { ...base, upstreamCount: 3 })).toBe(true)
  expect(sourceChanged(base, null)).toBe(true)
  expect(sourceChanged(null, base)).toBe(true)
  expect(sourceChanged(null, null)).toBe(false)
})

test("a poll captured before a connect, replace or disconnect is ignored", () => {
  const gate = new PollGate()
  const slowPoll = gate.ticket()
  expect(gate.isFresh(slowPoll)).toBe(true)
  gate.bump()
  expect(gate.isFresh(slowPoll)).toBe(false)
  const next = gate.ticket()
  expect(gate.isFresh(next)).toBe(true)
  gate.bump()
  expect(gate.isFresh(next)).toBe(false)
})

test("polling continues until the server explicitly says device sync is unavailable", () => {
  expect(shouldPoll(null)).toBe(true)
  expect(shouldPoll({ available: true, source: null })).toBe(true)
  expect(shouldPoll({ available: false, source: null })).toBe(false)
})
