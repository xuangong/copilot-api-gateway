#!/usr/bin/env bun
/**
 * Runs every fast-tier test file in its own `bun test` process.
 *
 * `bun test` shares one process across files, so a file that never sets up the
 * platform (repo, background, cache…) can pass only because an earlier file
 * left those singletons behind — and then fails when run alone or reordered.
 * This catches that coupling. Usage: `bun scripts/test-tiers/isolation.ts [-j N]`.
 */
import { join } from "node:path"
import { cpus } from "node:os"
import { classifyTestFile, listTestFiles } from "./tiers"

const jIndex = process.argv.indexOf("-j")
const parallel = jIndex > 0 ? Number(process.argv[jIndex + 1]) : Math.max(2, cpus().length)
const root = join(import.meta.dir, "../..")
const files = (await listTestFiles(root)).filter(rel => classifyTestFile(rel) === "fast")
const failures: Array<{ file: string; output: string }> = []
let next = 0
async function worker() {
  while (next < files.length) {
    const file = files[next++]!
    const child = Bun.spawn([process.execPath, "test", `./${file}`], { cwd: root, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) failures.push({ file, output: `${out}${err}` })
  }
}
await Promise.all(Array.from({ length: parallel }, worker))
for (const { file, output } of failures) {
  console.error(`\n=== ${file} fails in isolation ===`)
  console.error(output.split("\n").filter(line => /^\(fail\)|error:/.test(line)).slice(0, 20).join("\n"))
}
console.error(`[test-isolation] ${files.length} files, ${failures.length} failing in isolation`)
process.exit(failures.length === 0 ? 0 : 1)
