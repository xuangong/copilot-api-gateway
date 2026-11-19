#!/usr/bin/env bun
/**
 * Run one test tier: `bun scripts/test-tiers/run.ts <fast|slow|research> [bun test flags…]`.
 * See tiers.ts for how files are assigned to tiers.
 */
import { join } from "node:path"
import { classifyTestFile, listTestFiles, type TestTier } from "./tiers"

const [tier, ...flags] = process.argv.slice(2)
if (tier !== "fast" && tier !== "slow" && tier !== "research") {
  console.error("usage: bun scripts/test-tiers/run.ts <fast|slow|research> [bun test flags…]")
  process.exit(2)
}
const root = join(import.meta.dir, "../..")
const files = (await listTestFiles(root)).filter(rel => classifyTestFile(rel) === (tier as TestTier))
console.error(`[test-tiers] ${tier}: ${files.length} files`)
// "./" prefix: bun test treats bare arguments as name filters, not paths.
const child = Bun.spawn([process.execPath, "test", ...flags, ...files.map(rel => `./${rel}`)], { cwd: root, stdio: ["inherit", "inherit", "inherit"] })
process.exit(await child.exited)
