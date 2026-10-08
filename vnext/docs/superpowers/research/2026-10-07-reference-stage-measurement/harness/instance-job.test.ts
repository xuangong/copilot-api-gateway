import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { supervise } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"

async function run(code: string, timeoutMs = 1000) {
  const directory = mkdtempSync(join(tmpdir(), "gateway-instance-process-"))
  mkdirSync(join(directory, "child"))
  const script = join(directory, "coordinator.ts")
  writeFileSync(script, `import { runInheritedProcess } from ${JSON.stringify(join(import.meta.dir, "instance-job.ts"))}\nconst result=await runInheritedProcess({command:process.execPath,args:["-e",${JSON.stringify(code)}],directory:${JSON.stringify(join(directory, "child"))},timeoutMs:${timeoutMs}})\nconsole.log(JSON.stringify(result))\nif(result.exitCode!==0 || result.timedOut || !result.groupClean) process.exitCode=1\n`)
  const supervision = await supervise({ command: process.execPath, args: [script], directory, timeoutMs: 10000 })
  return { directory, supervision, stdout: readFileSync(join(directory, "stdout.log"), "utf8"), stderr: readFileSync(join(directory, "stderr.log"), "utf8") }
}

test("instance child inherits the owned group and exits without leftover members", async () => {
  const result = await run('console.log("fixture-output")')
  expect(result.supervision.exitCode).toBe(0)
  expect(result.supervision.cleanupComplete).toBe(true)
  const child = JSON.parse(result.stdout)
  expect(child.parentGroup).toBe(result.supervision.pid)
  expect(child.groupClean).toBe(true)
  expect(readFileSync(join(result.directory, "child/stdout.log"), "utf8")).toContain("fixture-output")
})

test("instance failure is retained and cannot qualify from a missing result", async () => {
  const result = await run('console.error("fixture-failure");process.exit(17)')
  expect(result.supervision.exitCode).toBe(1)
  expect(result.supervision.cleanupComplete).toBe(true)
  expect(JSON.parse(result.stdout).exitCode).toBe(17)
  expect(readFileSync(join(result.directory, "child/stderr.log"), "utf8")).toContain("fixture-failure")
})

test("an instance deadline retains failure and lets the outer owned group clean descendants", async () => {
  const result = await run('Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdio:["ignore","ignore","ignore"]});setInterval(()=>{},1000)', 100)
  expect(result.supervision.exitCode).toBe(1)
  expect(result.supervision.cleanupComplete).toBe(true)
  expect(JSON.parse(result.stdout).timedOut).toBe(true)
  expect(result.supervision.actions.length).toBeGreaterThan(0)
})
