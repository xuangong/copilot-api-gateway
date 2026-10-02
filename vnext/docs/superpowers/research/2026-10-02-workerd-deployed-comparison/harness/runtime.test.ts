import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Runtime } from "./runtime.ts"
import { Journal, readJournal } from "./journal.ts"
import type { Manifest } from "./manifest.ts"
import { hot } from "./types.ts"
import { verifyWireEvidence } from "./readback.ts"

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
    expect(row.eofMs).toBeNull()
    expect(row.failureElapsedMs).toBeGreaterThanOrEqual(0)
    expect(row.errors.join(",")).toContain("injected fetch failure")
    const rows = readJournal(path)
    expect(rows.map(row => row.event)).toEqual(["offered", "terminal"])
    expect(rows[0]?.id).toBe(rows[1]?.id)
    const wirePath = rows[1]?.wireEvidence
    if (typeof wirePath !== "string") throw new Error("Missing wire evidence")
    expect(row.wireEvidence).toBe(wirePath)
    expect(runtime.rows[0]?.wireEvidence).toBe(wirePath)
    verifyWireEvidence(row)
    const wire = JSON.parse(readFileSync(wirePath, "utf8")) as { requestBody: string }
    expect(wire.requestBody).toContain("BENCH_PAYLOAD:" + "x".repeat(65536) + ":END_PAYLOAD")
  } finally { globalThis.fetch = originalFetch; journal.close() }
})
test("EOF latency stops at reader.done before JSON parsing and wire oracle work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "request-eof-proof-"))
  const journal = new Journal(join(directory, "journal.jsonl"))
  const runtime = new Runtime({ id: "eof-experiment" } as Manifest, directory, journal, "latency-pair")
  const originalFetch = globalThis.fetch
  const originalNow = performance.now
  const originalParse = JSON.parse
  let clock = 100
  const wire = JSON.stringify({ object: "response", status: "completed", usage: { input_tokens: 7, output_tokens: 3 }, output: [{ content: [{ type: "output_text", text: "BENCH_OK:65536" }] }] })
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (clock === 100) { clock = 120; controller.enqueue(new TextEncoder().encode(wire)) }
      else { clock = 140; controller.close() }
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } })
  performance.now = () => clock
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
    const result: unknown = originalParse(...args)
    if (args[0] === wire) {
      // Parsing takes 1,000ms; oracle field access takes another 1,000ms.
      clock += 1000
      if (!result || typeof result !== "object") throw new Error("Invalid response fixture")
      Object.defineProperty(result, "object", { get() { clock += 1000; return "response" } })
    }
    return result
  }
  globalThis.fetch = Object.assign(async () => response, { preconnect: originalFetch.preconnect })
  try {
    const row = await runtime.request({ base: "http://127.0.0.1", directory }, "A", "latency", hot(false))
    expect(row.transportCompleted).toBe(true)
    expect(row.ok).toBe(true)
    expect(row.eofMs).toBe(40)
    expect(row.failureElapsedMs).toBeNull()
    expect(clock).toBeGreaterThanOrEqual(2140)
    expect(runtime.rows[0]?.wireEvidence).toBe(row.wireEvidence)
    expect(readJournal(journal.path)[1]?.wireEvidence).toBe(row.wireEvidence)
    verifyWireEvidence(row)
  } finally { globalThis.fetch = originalFetch; performance.now = originalNow; JSON.parse = originalParse; journal.close() }
})
