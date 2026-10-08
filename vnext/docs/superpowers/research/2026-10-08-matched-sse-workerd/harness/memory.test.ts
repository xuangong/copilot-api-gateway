import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { supervise } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"
import { fileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { freezeMemoryPlan, qualifyMemoryTrace } from "./memory-contracts"
import { reaggregateMemoryStudy, runMemoryStudy } from "./memory"
import type { MatchedContext } from "./coordinator"
import { verifyMatchedBundleIdentity } from "./inputs"
import { verifyMemoryBarrierReceipt } from "./memory-barrier"

const provenanceDirectories: string[] = []
afterEach(() => { for (const directory of provenanceDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function provenanceFixture() {
  const directory = mkdtempSync(join(tmpdir(), "gateway-memory-provenance-"))
  provenanceDirectories.push(directory)
  const save = (name: string, value: string) => { const path = join(directory, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); return fileIdentity(path) }
  const b = save("B/worker.mjs", "export default 'B'\n"), r = save("R/worker.mjs", "export default 'R'\n")
  const bSource = save("B/source.ts", "export const candidate = true\n"), dependency = save("dependency.js", "export const dependency = true\n")
  const migrations = Array.from({ length: 86 }, (_, index) => save(`R/migrations/${String(index).padStart(4, "0")}.sql`, `-- frozen migration ${index}\n`))
  const context: MatchedContext = {
    manifest: {
      version: 1, id: "memory-provenance-fixture", createdAt: "2026-10-08T00:00:00.000Z", count: 40, warmup: 12, expected: 716,
      variants: {
        A: { root: "/missing-historical-A", head: "unused", files: [{ path: "/missing-historical-A/source.ts", bytes: 1, sha256: "0".repeat(64) }], bundle: "/missing-historical-A/worker.mjs", migrationRoot: "/missing-historical-A/migrations", representation: "deployed-legacy" },
        B: { root: join(directory, "B"), head: "frozen-B", files: [bSource], bundle: b.path, migrationRoot: join(directory, "B/migrations"), representation: "current-v1" },
      },
      execution: fileIdentity(realpathSync(process.execPath)), resolution: [], tools: [], dependencies: [dependency], artifacts: [b, r],
      runtime: { bun: "1.3.0", miniflare: "4.20260601.0", workerd: "1.20260601.1", wrangler: "4.97.0", compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"] }, build: [],
    },
    referenceRoot: join(directory, "R"), reference: { bundle: r.path, migrationRoot: join(directory, "R/migrations"), inputs: migrations, resolutionNotes: [] },
  }
  const sourceContext = save("freeze/context.json", JSON.stringify(context)), instanceContext = save("instance-context.json", JSON.stringify(context))
  const inputs = { schema: "br-memory-inputs-v1", sourceContext, instanceContext }
  writeFileSync(join(directory, "memory-inputs.json"), JSON.stringify(inputs))
  const plan = freezeMemoryPlan("memory-provenance")
  writeFileSync(join(directory, "memory-plan.json"), JSON.stringify(plan))
  const window = plan.windows[0]
  if (!window) throw new Error("Missing provenance fixture window")
  const windowDirectory = join(directory, "windows", window.id)
  mkdirSync(windowDirectory, { recursive: true })
  const job = { context: { path: instanceContext.path, sha256: instanceContext.sha256 } }
  const identity = { arm: "B", workerBundle: b }
  writeFileSync(join(windowDirectory, "instance-job.json"), JSON.stringify(job))
  writeFileSync(join(windowDirectory, "identity.json"), JSON.stringify(identity))
  return { directory, context, inputs, b, r, bSource, dependency, migrations, window, windowDirectory, job, identity }
}

test("offline memory qualification verifies frozen B/R inputs without consulting historical A", async () => {
  const fixture = provenanceFixture()
  const result = await reaggregateMemoryStudy(fixture.directory)
  expect(result.inputQualification.passed).toBe(true)
  expect(result.errors.some(error => error.startsWith("Memory inputs:"))).toBe(false)
  writeFileSync(fixture.dependency.path, "changed dependency\n")
  const changed = await reaggregateMemoryStudy(fixture.directory)
  expect(changed.comparisonQualified).toBe(false)
  expect(changed.errors.some(error => error.startsWith("Memory inputs:") && error.includes("Input drift"))).toBe(true)
})

test.each(["B", "R"] as const)("shared bundle comparison selects the %s artifact and rejects every changed identity field", arm => {
  const fixture = provenanceFixture(), expected = arm === "B" ? fixture.b : fixture.r
  expect(verifyMatchedBundleIdentity(fixture.context, arm, expected)).toEqual(expected)
  for (const actual of [{ ...expected, path: arm === "B" ? fixture.r.path : fixture.b.path }, { ...expected, bytes: expected.bytes + 1 }, { ...expected, sha256: "0".repeat(64) }, undefined]) {
    expect(() => verifyMatchedBundleIdentity(fixture.context, arm, actual)).toThrow("bundle identity")
  }
  fixture.context.manifest.artifacts.push(expected)
  expect(() => verifyMatchedBundleIdentity(fixture.context, arm, expected)).toThrow("one frozen artifact")
  fixture.context.manifest.artifacts = []
  expect(() => verifyMatchedBundleIdentity(fixture.context, arm, expected)).toThrow("one frozen artifact")
  expect(() => verifyMatchedBundleIdentity(fixture.context, "A", expected)).toThrow("arm B or R")
})

test("memory preflight rejects a changed supplied context SHA before starting any window", async () => {
  const fixture = provenanceFixture(), directory = join(fixture.directory, "run-output")
  await expect(runMemoryStudy({ context: { path: fixture.inputs.sourceContext.path, sha256: "0".repeat(64) }, directory, runId: "memory-preflight" })).rejects.toThrow("context SHA")
  expect(existsSync(join(directory, "windows"))).toBe(false)
})

test("memory preflight rejects changed frozen inputs before creating a sampler or gateway window", async () => {
  const fixture = provenanceFixture(), directory = join(fixture.directory, "run-output")
  writeFileSync(fixture.b.path, "changed B bundle\n")
  await expect(runMemoryStudy({ context: fixture.inputs.sourceContext, directory, runId: "memory-preflight" })).rejects.toThrow("Input drift")
  expect(existsSync(join(directory, "windows"))).toBe(false)
  expect(fileIdentity(join(directory, "instance-context.json")).sha256).toBe(fixture.inputs.sourceContext.sha256)
})

test.each(["B bundle", "R bundle", "B source", "R input", "source context", "archived context"])("offline memory qualification rejects changed %s bytes", async kind => {
  const fixture = provenanceFixture()
  const migration = fixture.migrations[0]
  if (!migration) throw new Error("Missing provenance migration fixture")
  const path = ({ "B bundle": fixture.b.path, "R bundle": fixture.r.path, "B source": fixture.bSource.path, "R input": migration.path, "source context": fixture.inputs.sourceContext.path, "archived context": fixture.inputs.instanceContext.path } as Record<string, string>)[kind]
  if (!path) throw new Error("Unknown provenance fixture mutation")
  writeFileSync(path, "mutated frozen input\n")
  const result = await reaggregateMemoryStudy(fixture.directory)
  expect(result.comparisonQualified).toBe(false)
  expect(result.errors.some(error => error.startsWith("Memory inputs:") && /drift|SHA|context/i.test(error))).toBe(true)
})

test.each(["path", "bytes", "sha256"])("offline memory qualification rejects a window bundle with changed %s", async field => {
  const fixture = provenanceFixture()
  const changed = { ...fixture.identity.workerBundle, [field]: field === "bytes" ? fixture.b.bytes + 1 : field === "sha256" ? "0".repeat(64) : fixture.r.path }
  writeFileSync(join(fixture.windowDirectory, "identity.json"), JSON.stringify({ ...fixture.identity, workerBundle: changed }))
  const result = await reaggregateMemoryStudy(fixture.directory)
  expect(result.errors.some(error => error.startsWith(fixture.window.id + ":") && error.includes("bundle identity"))).toBe(true)
})

test("offline memory qualification rejects a window linked to another internally consistent context", async () => {
  const fixture = provenanceFixture(), otherPath = join(fixture.directory, "another-context.json")
  writeFileSync(otherPath, JSON.stringify(fixture.context))
  writeFileSync(join(fixture.windowDirectory, "instance-job.json"), JSON.stringify({ ...fixture.job, context: { path: otherPath, sha256: fileIdentity(otherPath).sha256 } }))
  const result = await reaggregateMemoryStudy(fixture.directory)
  expect(result.errors.some(error => error.startsWith(fixture.window.id + ":") && error.includes("run context"))).toBe(true)
})

const darwinTest = process.platform === "darwin" ? test : test.skip

test.each(["SIGINT", "SIGTERM"] as const)("%s cancels memory supervision and removes its temporary signal handlers", async signalName => {
  const script = `import { withMemoryInterrupts } from ${JSON.stringify(join(import.meta.dir, "memory.ts"))}
const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
const aborted = await withMemoryInterrupts(async signal => {
  const result = new Promise(resolve => signal.addEventListener("abort", () => resolve(signal.aborted), { once: true }))
  process.kill(process.pid, ${JSON.stringify(signalName)})
  return result
})
console.log(JSON.stringify({ aborted, before, after: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")] }))
`
  const child = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  const result = JSON.parse(stdout)
  expect(result.aborted).toBe(true)
  expect(result.after).toEqual(result.before)
})

test("memory supervision removes signal handlers when the supervised action rejects", async () => {
  const script = `import { withMemoryInterrupts } from ${JSON.stringify(join(import.meta.dir, "memory.ts"))}
const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
let error = null
try { await withMemoryInterrupts(async () => { throw new Error("supervisor-failure") }) }
catch (failure) { error = String(failure) }
console.log(JSON.stringify({ error, before, after: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")] }))
`
  const child = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  const result = JSON.parse(stdout)
  expect(result.error).toBe("Error: supervisor-failure")
  expect(result.after).toEqual(result.before)
})

darwinTest("an empty owned group is rejected without leaving a detached sampler", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-memory-sampler-"))
  const coordinator = join(directory, "coordinator.ts")
  writeFileSync(coordinator, `import { startMemorySampler } from ${JSON.stringify(join(import.meta.dir, "memory.ts"))}\nconst sampler = await startMemorySampler(${JSON.stringify(directory)})\nconst receipt = await sampler.stop()\nconsole.log(JSON.stringify(receipt))\n`)
  const supervision = await supervise({ command: process.execPath, args: [coordinator], directory, timeoutMs: 10_000 })
  expect(supervision.exitCode).toBe(0)
  expect(supervision.cleanupComplete).toBe(true)
  const receipt = JSON.parse(readFileSync(join(directory, "stdout.log"), "utf8"))
  expect(receipt.finished).toBe(true)
  expect(receipt.exitCode).toBe(1)
  expect(receipt.cleanupComplete).toBe(true)
  expect(receipt.forced).toEqual([])
  const trace = readFileSync(join(directory, "memory-samples.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
  expect(trace[0].targetGroup).toBe(supervision.pid)
  expect(trace[0].samplerGroup).toBe(receipt.pid)
  expect(trace[0].samplerGroup).not.toBe(supervision.pid)
  expect(trace.at(-1).completed).toBe(false)
  expect(trace.at(-1).error).toContain("resolved workerd lifecycle")
}, 15_000)

darwinTest("the live barrier brackets a synthetic workerd process before disposal and records its complete exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-memory-synthetic-"))
  const fixture = join(directory, "workerd")
  // Relocating an Apple system binary can trigger SIGKILL; compile a tiny identity fixture.
  execFileSync("clang", ["-x", "c", "-o", fixture, "-"], { input: "#include <unistd.h>\nint main(void) { sleep(5); return 0; }\n", timeout: 5_000 })
  const coordinator = join(directory, "coordinator.ts")
  writeFileSync(coordinator, `import { spawn } from "node:child_process"\nimport { startMemorySampler } from ${JSON.stringify(join(import.meta.dir, "memory.ts"))}\nimport { readProcessResource } from ${JSON.stringify(join(import.meta.dir, "../../2026-10-07-reference-stage-measurement/harness/process-resources.ts"))}\nconst child = spawn(${JSON.stringify(fixture)}, ["5"], { stdio: "ignore" })\nconst exited = new Promise(resolve => child.once("exit", resolve))\nconst sampler = await startMemorySampler(${JSON.stringify(directory)})\nawait Bun.sleep(250)\nif (!child.pid) throw new Error("Synthetic child missing")\nconst processStart = await readProcessResource(child.pid)\nawait Bun.sleep(400)\nconst processEnd = await readProcessResource(child.pid)\nconst { waitForMemoryAfterSample } = await import(${JSON.stringify(join(import.meta.dir, "memory-barrier.ts"))})\nconst { stop, ...samplerIdentity } = sampler\nawait waitForMemoryAfterSample({ directory: ${JSON.stringify(directory)}, windowId: "synthetic-live-barrier", sampler: samplerIdentity, processStart, processEnd })\nchild.kill("SIGTERM")\nawait exited\nconst receipt = await sampler.stop()\nconsole.log(JSON.stringify({ receipt, interval: { ownerPid: process.pid, processStart, processEnd } }))\n`)
  const supervision = await supervise({ command: process.execPath, args: [coordinator], directory, timeoutMs: 10_000 })
  expect(supervision.exitCode).toBe(0)
  expect(supervision.cleanupComplete).toBe(true)
  const result = JSON.parse(readFileSync(join(directory, "stdout.log"), "utf8"))
  expect(result.receipt.exitCode).toBe(0)
  expect(result.receipt.cleanupComplete).toBe(true)
  const events = readFileSync(join(directory, "memory-samples.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
  const barrier = JSON.parse(readFileSync(join(directory, "memory-barrier.json"), "utf8"))
  expect(verifyMemoryBarrierReceipt(readFileSync(join(directory, "memory-samples.jsonl"), "utf8"), barrier, { directory, windowId: "synthetic-live-barrier", sampler: { pid: result.receipt.pid, startIdentity: result.receipt.startIdentity, ownerPid: result.receipt.ownerPid, ownerIdentity: result.receipt.ownerIdentity }, processStart: result.interval.processStart, processEnd: result.interval.processEnd })).toEqual(barrier)
  const qualified = qualifyMemoryTrace(events, result.interval)
  expect(qualified.qualified).toBe(true)
  expect(qualified.pid).toBe(result.interval.processStart.pid)
  expect(qualified.pid).not.toBe(supervision.pid)
  expect(qualified.timedSamples).toBeGreaterThan(0)
}, 15_000)

darwinTest("group enumeration finds only the owned group using libproc buffer byte counts", async () => {
  const script = `import os, runpy, sys\nmodule = runpy.run_path(sys.argv[1])\nsource = module["Path"](sys.argv[1]).resolve().parents[2] / "2026-10-07-reference-stage-measurement/harness/process-resource-probe.py"\nprobe = runpy.run_path(str(source))["DarwinProbe"]()\npids = module["GroupProbe"](probe).pids(os.getpgid(0))\nassert os.getpid() in pids\nassert all(os.getpgid(pid) == os.getpgid(0) for pid in pids)\nprint("group-qualified")\n`
  const child = Bun.spawn(["python3", "-I", "-B", "-c", script, join(import.meta.dir, "memory-sampler.py")], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "group-qualified\n", stderr: "" })
})

darwinTest("group discovery skips real protected ps helpers before reading rusage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-memory-protected-ps-"))
  provenanceDirectories.push(directory)
  const script = `import ctypes, errno, json, os, runpy, signal, subprocess, sys
module = runpy.run_path(sys.argv[1])
source = module["Path"](sys.argv[1]).resolve().parents[2] / "2026-10-07-reference-stage-measurement/harness/process-resource-probe.py"
probe = runpy.run_path(str(source))["DarwinProbe"]()
owner = probe.sample(os.getpid())
group = module["GroupProbe"](probe)
confirmed = 0
for _ in range(3):
    child = subprocess.Popen(["/bin/ps", "-A", "-ww", "-o", "pid=,ppid=,pgid=,comm="], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        os.kill(child.pid, signal.SIGSTOP)
        path = ctypes.create_string_buffer(4096)
        assert probe.lib.proc_pidpath(child.pid, path, len(path)) > 0
        assert path.value == b"/bin/ps"
        try:
            probe.sample(child.pid)
            raise AssertionError("Protected ps fixture unexpectedly allowed rusage")
        except OSError as error:
            assert error.errno == errno.EPERM
            confirmed += 1
        assert group.workerd(os.getpid(), owner["startIdentity"]) == []
    finally:
        os.kill(child.pid, signal.SIGCONT)
        child.communicate(timeout=5)
print(json.dumps({"confirmedPermissionErrors": confirmed, "discoveryPassed": True}))
`
  const supervision = await supervise({ command: "python3", args: ["-I", "-B", "-c", script, join(import.meta.dir, "memory-sampler.py")], directory, timeoutMs: 10_000 })
  expect({ exitCode: supervision.exitCode, cleanupComplete: supervision.cleanupComplete, stderr: readFileSync(join(directory, "stderr.log"), "utf8") }).toEqual({ exitCode: 0, cleanupComplete: true, stderr: "" })
  expect(JSON.parse(readFileSync(join(directory, "stdout.log"), "utf8"))).toEqual({ confirmedPermissionErrors: 3, discoveryPassed: true })
}, 15_000)

darwinTest("a detached sampler exits when its coordinator disappears without stop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-memory-orphan-"))
  const coordinator = join(directory, "coordinator.ts")
  writeFileSync(coordinator, `import { startMemorySampler } from ${JSON.stringify(join(import.meta.dir, "memory.ts"))}\nconst sampler = await startMemorySampler(${JSON.stringify(directory)})\nconsole.log(sampler.pid)\nprocess.exit(17)\n`)
  const supervision = await supervise({ command: process.execPath, args: [coordinator], directory, timeoutMs: 10_000 })
  expect(supervision.exitCode).toBe(17)
  expect(supervision.cleanupComplete).toBe(true)
  const pid = Number(readFileSync(join(directory, "stdout.log"), "utf8").trim())
  let gone = false
  const ends = Date.now() + 2_000
  while (!gone && Date.now() < ends) {
    try { process.kill(pid, 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") gone = true; else throw error }
    if (!gone) await new Promise<void>(accept => setTimeout(accept, 10))
  }
  expect(gone).toBe(true)
  const trace = readFileSync(join(directory, "memory-samples.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
  expect(trace.at(-1).kind).toBe("stopped")
  expect(trace.at(-1).completed).toBe(false)
}, 15_000)

test("offline memory qualification retains all missing windows instead of rebalancing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-memory-missing-"))
  writeFileSync(join(directory, "memory-plan.json"), JSON.stringify(freezeMemoryPlan("memory-missing")))
  const result = await reaggregateMemoryStudy(directory)
  expect(result.comparisonQualified).toBe(false)
  expect(result.expectedWindows).toBe(12)
  expect(result.observedQualifiedWindows).toBe(0)
  expect(result.errors.filter(error => error.startsWith("memory-missing-"))).toHaveLength(12)
  expect(result.groups.every(group => !group.qualified)).toBe(true)
  expect(result.cpuLatencyExcluded).toBe(true)
})
