/**
 * Every translation pair module (request, body, events) has its own test file,
 * mirrored under tests/<pair>/. A pair whose request translation is never
 * exercised can drop client input silently — the class of bug reference
 * copilot-gateway #619 fixed — so "each protocol × upstream kind has at least
 * one fixture" (vnext/AGENTS.md §4.3) is enforced here instead of by review.
 */
import { expect, test } from "bun:test"
import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "../src")
const TESTS = join(import.meta.dir)
const MODULES = ["request", "body", "events"] as const

test("each translation pair has a mirrored test file per module", () => {
  const missing: string[] = []
  for (const pair of readdirSync(SRC).filter(name => name.includes("-via-"))) {
    for (const module of MODULES) {
      if (!existsSync(join(SRC, pair, `${module}.ts`))) continue
      if (!existsSync(join(TESTS, pair, `${module}.test.ts`))) missing.push(`${pair}/${module}.test.ts`)
    }
  }
  expect(missing).toEqual([])
})
