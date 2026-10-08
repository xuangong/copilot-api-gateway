import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freezeMatchedPlan } from "./contracts"
import { reaggregateMatchedOutput, runMatchedComparison, verifyMatchedWindowIndex } from "./coordinator"

const directories: string[] = []
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), "matched-sse-contract-")); directories.push(directory); return directory }
function fixtureAt<T>(values: readonly T[], index = 0): T {
  const value = values[index]
  if (value === undefined) throw new Error(`Missing fixture at index ${index}`)
  return value
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

test("offline reaggregation rejects missing raw windows despite a cached successful summary", async () => {
  const output = temporary()
  writeFileSync(join(output, "experiment-plan.json"), JSON.stringify(freezeMatchedPlan({ runId: "missing" })))
  writeFileSync(join(output, "matched-summary.json"), JSON.stringify({ comparisonQualified: true, totals: { timedOffered: 960 } }))
  const summary = await reaggregateMatchedOutput(output)
  expect(summary.comparisonQualified).toBe(false)
  expect(summary.totals).toMatchObject({ expectedWindows: 48, observedWindows: 0, timedOffered: 0, cpuMs: null })
  expect(summary.errors.some(error => error.includes("Missing window"))).toBe(true)
  expect(summary.rawWire.checkedRows).toBe(0)
})

test("coordinator refuses an existing output directory without altering prior evidence", async () => {
  const output = temporary(), path = join(output, "sentinel.json")
  writeFileSync(path, "preserve")
  await expect(runMatchedComparison("missing-context.json", output)).rejects.toThrow("already exists")
  expect(readFileSync(path, "utf8")).toBe("preserve")
})

test("offline index rejects fatal, duplicate and unexpected windows even when marked complete", () => {
  const output = temporary(), plan = freezeMatchedPlan({ runId: "index" })
  const windows = plan.windows.map(window => { const directory = join(output, "windows", window.id); return { id: window.id, arm: window.arm, directory, receipt: join(directory, "receipt.json"), observations: join(directory, "observations.json") } })
  const index = { completed: true, expected: 48, windows }
  writeFileSync(join(output, "window-index.json"), JSON.stringify(index))
  expect(verifyMatchedWindowIndex(output, plan)).toMatchObject({ passed: true })
  for (const invalid of [{ ...index, fatal: "input drift" }, { ...index, windows: [...windows.slice(1), fixtureAt(windows, 1)] }, { ...index, windows: [...windows, { ...fixtureAt(windows), id: "unexpected" }] }]) {
    writeFileSync(join(output, "window-index.json"), JSON.stringify(invalid))
    expect(() => verifyMatchedWindowIndex(output, plan)).toThrow()
  }
  writeFileSync(join(output, "window-index.json"), JSON.stringify(index))
  mkdirSync(join(output, "windows", "unexpected"), { recursive: true })
  expect(() => verifyMatchedWindowIndex(output, plan)).toThrow("Unexpected")
})

test("incomplete native readback retains observed requests and measured process CPU", async () => {
  const output = temporary(), plan = freezeMatchedPlan({ runId: "partial" }), window = fixtureAt(plan.windows)
  writeFileSync(join(output, "experiment-plan.json"), JSON.stringify(plan))
  const directory = join(output, "windows", window.id)
  mkdirSync(directory, { recursive: true })
  const start = { pid: 42, startIdentity: "darwin-abstime:1", executableName: "workerd", scope: "darwin-process-libproc-rusage-v2", observedAtMs: 1, userUs: 10, systemUs: 5, rssBytes: 100 }
  writeFileSync(join(directory, "observations.json"), JSON.stringify({ rows: Array.from({ length: 20 }, (_, i) => ({ id: `${window.id}-timed-${String(i).padStart(3, "0")}`, phase: "timed", ok: false })), dispatches: [], processStart: start, processEnd: { ...start, observedAtMs: 100, userUs: 2010, systemUs: 1005 }, resources: { pid: 42, startIdentity: start.startIdentity, scope: start.scope, elapsedMs: 99, userUs: 2000, systemUs: 1000, cpuUs: 3000 }, warmupSettlement: { active: 0, pending: 0, registered: 5, settled: 5, failures: [], observerFailures: 0, unowned: 0 }, settlement: { active: 0, pending: 0, registered: 25, settled: 25, failures: [], observerFailures: 0, unowned: 0 }, scope: "warmed-through-settlement" }))
  const result = await reaggregateMatchedOutput(output)
  expect(result.comparisonQualified).toBe(false)
  expect(result.totals.timedOffered).toBe(20)
  expect(fixtureAt(fixtureAt(result.groups).blocks)).toMatchObject({ offered: 20, successes: 0, cpuMs: 3, cpuPerOfferedMs: 0.15 })
})
