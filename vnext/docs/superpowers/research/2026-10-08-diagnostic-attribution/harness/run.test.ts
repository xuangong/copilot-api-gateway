import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import { freezeMappingRuntimeInputs } from "./run"
import { freezeObserverPlan } from "./runner"
import { makeRequest } from "../../2026-10-07-reference-stage-measurement/harness/contracts"
import { requestIdentity } from "../../2026-10-07-reference-stage-measurement/harness/warm-contracts"
import { sha, verifyFiles } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"

test("fixed observer IDs preserve equal full request bytes across both cells and all modes within each phase", () => {
  const windows = freezeObserverPlan().windows
  expect(new Set(windows.map(w => w.id.length)).size).toBe(1)
  for (const phase of ["warmup", "timed"] as const) for (const index of Array.from({ length: phase === "warmup" ? 5 : 30 }, (_, index) => index)) {
    const normalized = windows.map(window => {
      const id = requestIdentity(window.id, phase, index)
      const body = makeRequest(id, window.cell)
      expect(Buffer.byteLength(body)).toBe(65536)
      return body.replace(`BENCH_ID:${id}`, "BENCH_ID:NORMALIZED")
    })
    expect(new Set(normalized).size).toBe(1)
    expect(new Set(normalized.map(value => sha(value))).size).toBe(1)
  }
})
test("freeze includes only the actual trace-mapping runtime JS and three package manifests", async () => {
  const identities = freezeMappingRuntimeInputs()
  expect(identities.length).toBe(6)
  const js = identities.filter(file => file.path.endsWith(".js"))
  expect(js.length).toBe(3)
  const trace = js.find(file => file.path.endsWith("/trace-mapping.umd.js"))
  if (!trace) throw new Error("Trace-mapping runtime entry missing")
  const require = createRequire(trace.path)
  expect(js.map(file => file.path).sort()).toEqual([trace.path, require.resolve("@jridgewell/resolve-uri"), require.resolve("@jridgewell/sourcemap-codec")].sort())
  expect(identities.filter(file => file.path.endsWith("/package.json")).map(file => dirname(file.path)).sort()).toEqual(js.map(file => dirname(dirname(file.path))).sort())
  await import(trace.path)
  expect(js.every(file => Object.keys(require.cache).includes(file.path))).toBe(true)
  verifyFiles(identities)
  expect(() => verifyFiles(identities.map((file, index) => index === 0 ? { ...file, sha256: "0".repeat(64) } : file))).toThrow()
})
