/**
 * Test tiers let a developer run the fast suite in a tight loop and leave
 * process-spawning, D1 (Miniflare) and workerd suites to CI. The tier is read
 * from the file name, so the rule below keeps names honest: a test that starts
 * a real process must say so with `.proc.test.ts`, or `test:fast` would
 * silently grow slow and environment-dependent again.
 */
import { expect, test } from "bun:test"
import { join } from "node:path"
import { classifyTestFile, listTestFiles, spawnsProcess } from "./tiers"

const ROOT = join(import.meta.dir, "../..")

test.each([
  ["packages/gateway/tests/chat.e2e.test.ts", "fast"],
  ["packages/gateway/tests/repo.sqlite.test.ts", "fast"],
  ["packages/translate/tests/shared/x.test.ts", "fast"],
  ["apps/dashboard/src/a/b.test.tsx", "fast"],
  ["packages/gateway/tests/telemetry-e2e.proc.test.ts", "slow"],
  ["apps/platform-cloudflare/src/setup-leases.d1.test.ts", "slow"],
  ["apps/platform-cloudflare/src/responses-websocket.workerd.test.ts", "slow"],
  ["docs/superpowers/research/2026-10-07-x/harness/memory.test.ts", "research"],
] as const)("%s is in the %s tier", (path, tier) => {
  expect(classifyTestFile(path)).toBe(tier)
})

test("spawn detection ignores template literals and matches real process APIs", () => {
  expect(spawnsProcess("const re = `${a}`")).toBe(false)
  expect(spawnsProcess("const child = Bun.spawn([cmd])")).toBe(true)
  expect(spawnsProcess("Bun.spawnSync(['bash'])")).toBe(true)
  expect(spawnsProcess('import { spawn } from "node:child_process"')).toBe(true)
})

test("every test that starts a real process is named .proc/.d1/.workerd", async () => {
  const misnamed: string[] = []
  for (const rel of await listTestFiles(ROOT)) {
    if (classifyTestFile(rel) !== "fast") continue
    if (spawnsProcess(await Bun.file(join(ROOT, rel)).text())) misnamed.push(rel)
  }
  // Allowed exception: this file names the APIs it detects.
  expect(misnamed.filter(rel => rel !== "scripts/test-tiers/tiers.test.ts")).toEqual([])
})
