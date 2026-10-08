import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { freezeMatchedPlan } from "./contracts"
import { readMatchedInstanceJob } from "./instance-job"

test("matched instance job binds the versioned adapter, context bytes and process ownership before execution", () => {
  const directory = mkdtempSync(join(tmpdir(), "matched-instance-job-"))
  try {
    const contextPath = join(directory, "context.json")
    writeFileSync(contextPath, JSON.stringify({ manifest: {}, referenceRoot: "/frozen-reference", reference: {} }))
    const context = { path: contextPath, sha256: sha(readFileSync(contextPath)) }
    const window = freezeMatchedPlan({ runId: "instance-test" }).windows[0]
    if (!window) throw new Error("Fixture window missing")
    const path = join(directory, "instance-job.json")
    const job = { version: 1, adapter: "matched-sse-instance-v1", kind: "warm-window", directory, context, window, parentPid: 12345 }
    const write = (value: unknown) => { writeFileSync(path, JSON.stringify(value)); return sha(readFileSync(path)) }
    const digest = write(job)
    expect(() => readMatchedInstanceJob(path, digest, { parentPid: 12345, group: 12345 })).not.toThrow()
    for (const ownership of [{ parentPid: 54321, group: 12345 }, { parentPid: 12345, group: 54321 }]) {
      expect(() => readMatchedInstanceJob(path, digest, ownership)).toThrow("ownership")
    }
    for (const patch of [{ adapter: "legacy" }, { version: 2 }, { kind: "ab-canary" }, { directory: directory + "-elsewhere" }, { window: { ...window, arm: "A" } }]) {
      expect(() => readMatchedInstanceJob(path, write({ ...job, ...patch }), { parentPid: 12345, group: 12345 })).toThrow()
    }
    write(job)
    expect(() => readMatchedInstanceJob(path, "0".repeat(64), { parentPid: 12345, group: 12345 })).toThrow("identity")
    writeFileSync(contextPath, "{}")
    expect(() => readMatchedInstanceJob(path, digest, { parentPid: 12345, group: 12345 })).toThrow("context")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
