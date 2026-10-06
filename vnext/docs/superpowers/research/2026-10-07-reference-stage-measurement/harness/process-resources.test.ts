import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"
import {
  diffProcessResource,
  discoverWorkerd,
  readProcessResource,
  type ProcessResource,
} from "./process-resources.ts"

const baseline: ProcessResource = {
  pid: 42,
  startIdentity: "darwin-abstime:100",
  executableName: "workerd",
  userUs: 1_000,
  systemUs: 2_000,
  rssBytes: 32_768,
  observedAtMs: 500,
  scope: "darwin-process-libproc-rusage-v2",
}

describe("process CPU intervals", () => {
  test("subtracts cumulative CPU counters without treating RSS as cumulative", () => {
    const end = {
      ...baseline,
      userUs: 1_123,
      systemUs: 2_200,
      rssBytes: 16_384,
      observedAtMs: 510,
    }
    expect(diffProcessResource(baseline, end)).toEqual({
      pid: 42,
      startIdentity: "darwin-abstime:100",
      scope: "darwin-process-libproc-rusage-v2",
      elapsedMs: 10,
      userUs: 123,
      systemUs: 200,
      cpuUs: 323,
    })
  })

  test.each([
    { pid: 43 },
    { startIdentity: "darwin-abstime:101" },
    { executableName: "bun" },
    { scope: "isolate" },
  ])("refuses an interval whose process identity or scope changed: %j", (change) => {
    expect(() => diffProcessResource(baseline, { ...baseline, ...change })).toThrow()
  })

  test.each([
    { userUs: 999 },
    { systemUs: 1_999 },
    { observedAtMs: 499 },
    { userUs: Number.NaN },
    { systemUs: -1 },
    { rssBytes: Number.POSITIVE_INFINITY },
    { userUs: Number.MAX_SAFE_INTEGER + 1 },
    { observedAtMs: Number.NaN },
  ])("rejects backwards or invalid counters instead of emitting misleading deltas: %j", (change) => {
    expect(() => diffProcessResource(baseline, { ...baseline, ...change })).toThrow()
  })

  test("allows equal CPU counters and equal timestamps for an idle sample", () => {
    expect(diffProcessResource(baseline, baseline).cpuUs).toBe(0)
  })
})

test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER])(
  "rejects an invalid PID before probing: %s",
  async (pid) => {
    await expect(readProcessResource(pid)).rejects.toThrow()
  },
)

const darwinTest = process.platform === "darwin" ? test : test.skip

darwinTest("discovery enumerates real child PIDs without confusing counts with buffer bytes", async () => {
  const probePath = fileURLToPath(new URL("./process-resource-probe.py", import.meta.url))
  const child = Bun.spawn(["python3", "-I", "-B", "-c", `
import json, os, runpy, subprocess, sys

probe = runpy.run_path(sys.argv[1])["DarwinProbe"]()
child = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
try:
    children = probe.children(os.getpid())
    print(json.dumps({"childFound": child.pid in children, "ownerExcluded": os.getpid() not in children}))
finally:
    child.communicate(input=b"", timeout=3)
`, probePath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [output, error, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, error }).toEqual({ exitCode: 0, error: "" })
  expect(JSON.parse(output)).toEqual({ childFound: true, ownerExcluded: true })
}, 10_000)

darwinTest("samples the selected child CPU and resident pages, not the observer parent", async () => {
  const child = spawn("python3", ["-I", "-u", "-c", `
import json, resource, sys, time

def report():
    usage = resource.getrusage(resource.RUSAGE_SELF)
    print(json.dumps({"userUs": int(usage.ru_utime * 1000000), "systemUs": int(usage.ru_stime * 1000000)}), flush=True)

report()
if sys.stdin.readline().strip() == "work":
    pages = bytearray(32 * 1024 * 1024)
    for offset in range(0, len(pages), 4096):
        pages[offset] = 1
    deadline = time.process_time() + 0.1
    while time.process_time() < deadline:
        sum(range(1000))
    report()
    sys.stdin.readline()
`], { stdio: ["pipe", "pipe", "pipe"], timeout: 5_000 })
  const lines = createInterface({ input: child.stdout })
  const iterator = lines[Symbol.asyncIterator]()
  try {
    const initialLine = await iterator.next()
    expect(initialLine.done).toBe(false)
    const pid = child.pid
    if (pid === undefined) throw new Error("Child did not start")
    const before = await readProcessResource(pid)
    child.stdin.write("work\n")
    const afterLine = await iterator.next()
    if (typeof afterLine.value !== "string") throw new Error("Child did not report CPU")
    const ownUsage: unknown = JSON.parse(afterLine.value)
    if (
      typeof ownUsage !== "object" || ownUsage === null ||
      !("userUs" in ownUsage) || typeof ownUsage.userUs !== "number" ||
      !("systemUs" in ownUsage) || typeof ownUsage.systemUs !== "number"
    ) throw new Error("Invalid child resource report")
    const after = await readProcessResource(pid)
    const interval = diffProcessResource(before, after)

    expect(after.pid).toBe(pid)
    expect(after.pid).not.toBe(process.pid)
    expect(after.executableName.toLowerCase()).toContain("python")
    expect(after.startIdentity).toBe(before.startIdentity)
    expect(after.observedAtMs).toBeGreaterThan(before.observedAtMs)
    expect(interval.cpuUs).toBeGreaterThan(90_000)
    expect(interval.cpuUs).toBeLessThan(500_000)
    expect(Math.abs(after.userUs - ownUsage.userUs)).toBeLessThan(30_000)
    expect(Math.abs(after.systemUs - ownUsage.systemUs)).toBeLessThan(30_000)
    expect(after.rssBytes - before.rssBytes).toBeGreaterThan(24 * 1024 * 1024)
    await expect(discoverWorkerd(pid)).rejects.toThrow(/no workerd descendant/i)
  } finally {
    lines.close()
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      child.kill("SIGTERM")
      await exited
    }
  }
}, 10_000)
