import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Runtime } from "./runtime.ts"
import { Journal, readJournal } from "./journal.ts"
import type { Manifest } from "./manifest.ts"
import { hot } from "./types.ts"

test("fetch failure observes an already durable offer and leaves one durable terminal with original input", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-request-proof-"))
  const path = join(directory, "journal.jsonl")
  const journal = new Journal(path)
  const manifest = { id: "test-experiment" } as Manifest
  const runtime = new Runtime(manifest, directory, journal, "latency-pair")
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(async () => {
    expect(readJournal(path)[0]?.event).toBe("offered")
    throw new Error("injected fetch failure")
  }, { preconnect: originalFetch.preconnect })
  try {
    const row = await runtime.request({ base: "http://127.0.0.1", directory }, "A", "latency", hot(false))
    expect(row.transportCompleted).toBe(false)
    expect(row.errors.join(",")).toContain("injected fetch failure")
    const rows = readJournal(path)
    expect(rows.map(row => row.event)).toEqual(["offered", "terminal"])
    expect(rows[0]?.id).toBe(rows[1]?.id)
    const wirePath = rows[1]?.wireEvidence
    if (typeof wirePath !== "string") throw new Error("Missing wire evidence")
    const wire = JSON.parse(readFileSync(wirePath, "utf8")) as { requestBody: string }
    expect(wire.requestBody).toContain("BENCH_PAYLOAD:" + "x".repeat(65536) + ":END_PAYLOAD")
  } finally { globalThis.fetch = originalFetch; journal.close() }
})
