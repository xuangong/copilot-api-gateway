import { test, expect } from "bun:test"
import { mergeRecords, type DumpMetadata } from "./dumps"

const row = (id: string, startedAt: number): DumpMetadata => ({
  id, startedAt, completedAt: startedAt + 1, method: "POST", path: "/v1/responses",
  status: 200, upstream: null, model: null, inputTokens: null, outputTokens: null,
  requestBytes: 0, responseBytes: 0, durationMs: 1, error: null,
})

test("page and live overlaps keep one newest-first record per ID", () => {
  const merged = mergeRecords([row("A", 1), row("B", 2)], [row("B", 2), row("C", 3)])
  expect(merged.map((record) => record.id)).toEqual(["C", "B", "A"])
  expect(mergeRecords(merged, [row("C", 3)]).length).toBe(3)
})

test("completion order matches the store even when an earlier request finishes later", () => {
  const longRequest = { ...row("LONG", 1), completedAt: 100 }
  const shortRequest = { ...row("SHORT", 50), completedAt: 51 }
  expect(mergeRecords([shortRequest], [longRequest]).map((record) => record.id)).toEqual(["LONG", "SHORT"])
})
