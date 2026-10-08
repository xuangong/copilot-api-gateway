import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { freezeMemoryPlan } from "./memory-contracts"
import { MEMORY_INSTANCE_ADAPTER, readMemoryInstanceJob } from "./memory-instance-job"

test("memory child binds its dedicated adapter, frozen population, sampler identity, context and inherited ownership", () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-instance-job-"))
  try {
    const contextPath = join(directory, "context.json")
    writeFileSync(contextPath, JSON.stringify({ manifest: {}, referenceRoot: "/frozen-reference", reference: {} }))
    const context = { path: contextPath, sha256: sha(readFileSync(contextPath)) }
    const window = freezeMemoryPlan("memory-instance-test").windows[0]
    if (!window) throw new Error("Missing memory fixture window")
    const path = join(directory, "instance-job.json")
    const sampler = { pid: 23456, startIdentity: "darwin-abstime:33", ownerPid: 12345, ownerIdentity: "darwin-abstime:22" }
    const job = { version: 1, adapter: MEMORY_INSTANCE_ADAPTER, kind: "warm-window", directory, context, window, parentPid: 12345, sampler }
    const write = (value: unknown) => { writeFileSync(path, JSON.stringify(value)); return sha(readFileSync(path)) }
    const ownership = { parentPid: 12345, group: 12345 }, digest = write(job)
    expect(() => readMemoryInstanceJob(path, digest, ownership)).not.toThrow()
    for (const changed of [{ parentPid: 54321, group: 12345 }, { parentPid: 12345, group: 54321 }]) expect(() => readMemoryInstanceJob(path, digest, changed)).toThrow("ownership")
    for (const patch of [
      { adapter: "matched-sse-instance-v1" }, { version: 2 }, { kind: "ab-canary" }, { directory: directory + "-elsewhere" },
      { window: { ...window, arm: "A" } }, { window: { ...window, warmup: 4 } }, { window: { ...window, timed: 19 } },
      { window: { ...window, cell: { ...window.cell, dump: true } } }, { window: { ...window, cell: { ...window.cell, stream: true } } },
      { sampler: { ...sampler, ownerPid: 111 } }, { sampler: { ...sampler, pid: 12345 } },
      { sampler: { ...sampler, startIdentity: "invalid" } }, { sampler: { ...sampler, ownerIdentity: "invalid" } },
    ]) expect(() => readMemoryInstanceJob(path, write({ ...job, ...patch }), ownership)).toThrow()
    write(job)
    expect(() => readMemoryInstanceJob(path, "0".repeat(64), ownership)).toThrow("identity")
    writeFileSync(contextPath, "{}")
    expect(() => readMemoryInstanceJob(path, digest, ownership)).toThrow("context")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
