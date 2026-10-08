import { afterEach, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProcessResource } from "../../2026-10-07-reference-stage-measurement/harness/process-resources"
import { verifyMemoryBarrierReceipt, waitForMemoryAfterSample } from "./memory-barrier"

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const resource = (at: number, patch: Partial<ProcessResource> = {}): ProcessResource => ({ pid: 39346, startIdentity: "darwin-abstime:4551453557829", executableName: "workerd", observedAtMs: at, userUs: 100, systemUs: 100, rssBytes: 1_000, scope: "darwin-process-libproc-rusage-v2", ...patch })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "memory-live-barrier-"))
  directories.push(directory)
  const sampler = { pid: 39322, startIdentity: "darwin-abstime:33", ownerPid: 39295, ownerIdentity: "darwin-abstime:22" }
  const options = { directory, windowId: "memory-02-gap-regression", sampler, processStart: resource(189644600.602666), processEnd: resource(189645424.505625), timeoutMs: 500 }
  const ready = { kind: "ready", schema: "sampled-rss-v1", requestedIntervalMs: 20, targetGroup: sampler.ownerPid, samplerGroup: sampler.pid, atMs: 189644000, owner: resource(189643990, { pid: sampler.ownerPid, startIdentity: sampler.ownerIdentity, executableName: "bun" }), sampler: resource(189643995, { pid: sampler.pid, startIdentity: sampler.startIdentity, executableName: "python3" }) }
  const sample = (at: number, patch: Partial<ProcessResource> = {}) => ({ kind: "sample", targetGroup: sampler.ownerPid, ownerIdentity: sampler.ownerIdentity, resource: resource(at, patch) })
  const events = [ready, ...[189644530.598791, 189644647.32825, 189644800, 189644950, 189645100, 189645250, 189645390.6685].map(at => sample(at))]
  const path = join(directory, "memory-samples.jsonl")
  const write = () => writeFileSync(path, events.map(event => JSON.stringify(event) + "\n").join(""))
  const append = (event: unknown) => appendFileSync(path, JSON.stringify(event) + "\n")
  write()
  return { directory, options, ready, sample, events, path, write, append }
}

test("memory-02 regression waits for an independent sample after processEnd before releasing readback", async () => {
  const f = fixture()
  let released = false
  const pending = waitForMemoryAfterSample(f.options).then(receipt => { released = true; return receipt })
  await Bun.sleep(25)
  expect(released).toBe(false)
  expect(existsSync(join(f.directory, "memory-barrier.json"))).toBe(false)
  const after = f.sample(189645480, { rssBytes: 999_999 })
  f.append(after)
  const receipt = await pending
  expect(receipt.after.resource).toEqual(after.resource)
  expect(receipt.after.line).toBe(f.events.length + 1)
  expect(verifyMemoryBarrierReceipt(readFileSync(f.path, "utf8"), receipt, f.options)).toEqual(receipt)
})

test("a sample is considered only after its raw JSONL record is complete", async () => {
  const f = fixture(), after = JSON.stringify(f.sample(189645480))
  let released = false
  const pending = waitForMemoryAfterSample(f.options).then(value => { released = true; return value })
  appendFileSync(f.path, after)
  await Bun.sleep(25)
  expect(released).toBe(false)
  appendFileSync(f.path, "\n")
  await pending
  expect(released).toBe(true)
})

test.each(["owner PID", "owner start", "sampler PID", "sampler start", "workerd PID", "workerd start", "sample owner"])("live barrier rejects changed %s identity", async kind => {
  const f = fixture()
  if (kind === "owner PID") f.ready.owner = { ...f.ready.owner, pid: f.ready.owner.pid + 1 }
  if (kind === "owner start") f.ready.owner = { ...f.ready.owner, startIdentity: "darwin-abstime:99" }
  if (kind === "sampler PID") f.ready.sampler = { ...f.ready.sampler, pid: f.ready.sampler.pid + 1 }
  if (kind === "sampler start") f.ready.sampler = { ...f.ready.sampler, startIdentity: "darwin-abstime:99" }
  f.write()
  const after = f.sample(189645480, kind === "workerd PID" ? { pid: 9999 } : kind === "workerd start" ? { startIdentity: "darwin-abstime:99" } : {})
  if (kind === "sample owner") after.ownerIdentity = "darwin-abstime:99"
  f.append(after)
  await expect(waitForMemoryAfterSample(f.options)).rejects.toThrow(/identity|ownership/)
  expect(existsSync(join(f.directory, "memory-barrier.json"))).toBe(false)
})

test.each(["stopped", "workerd-exited"])("live barrier rejects %s instead of silently releasing a failed sampler", async kind => {
  const f = fixture()
  const pending = waitForMemoryAfterSample(f.options)
  f.append({ kind, error: "sampling failed" })
  await expect(pending).rejects.toThrow(/stopped|exited/)
})

test("missing after sample expires its deadline and cannot later create a success receipt", async () => {
  const f = fixture()
  await expect(waitForMemoryAfterSample({ ...f.options, timeoutMs: 20 })).rejects.toThrow("deadline")
  f.append(f.sample(189645480))
  await Bun.sleep(25)
  expect(existsSync(join(f.directory, "memory-barrier.json"))).toBe(false)
})

test("an after sample cannot relax the original 250ms qualification bound", async () => {
  const f = fixture()
  f.append(f.sample(189645700))
  await expect(waitForMemoryAfterSample(f.options)).rejects.toThrow("250 ms")
})

test("offline barrier verification rejects fabricated sample, raw line, endpoint and sampler receipts", async () => {
  const f = fixture()
  f.append(f.sample(189645480))
  const receipt = await waitForMemoryAfterSample(f.options), trace = readFileSync(f.path, "utf8")
  for (const patch of [
    { after: { ...receipt.after, resource: f.options.processEnd } },
    { after: { ...receipt.after, line: receipt.after.line - 1 } },
    { after: { ...receipt.after, sha256: "0".repeat(64) } },
    { processEnd: resource(189645425) },
    { sampler: { ...receipt.sampler, startIdentity: "darwin-abstime:99" } },
  ]) expect(() => verifyMemoryBarrierReceipt(trace, { ...receipt, ...patch }, f.options)).toThrow()
})
