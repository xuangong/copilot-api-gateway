/**
 * Hand-written Repo fakes (`… as unknown as Repo`) drift from the real
 * contract — e.g. ignoring the owner half of a composite key — and each one
 * re-implements tens of methods. New tests use the real repo over in-memory
 * SQLite from `setupTestPlatform()` (tests/_setup-platform.ts), storing rows
 * instead of stubbing lookups; see control-plane-copilot-quota.test.ts.
 *
 * This is a ratchet: the count may only go down. When you migrate a file,
 * lower MAX to the new count.
 */
import { expect, test } from "bun:test"
import { Glob } from "bun"
import { join } from "node:path"

const MAX = 77
const ROOT = join(import.meta.dir, "../..")

test("hand-written Repo fakes do not grow", async () => {
  let count = 0
  for (const dir of ["tests", "src"]) {
    for await (const rel of new Glob("**/*.ts").scan(join(ROOT, dir))) {
      if (rel.endsWith("repo-fakes-ratchet.test.ts")) continue
      count += ((await Bun.file(join(ROOT, dir, rel)).text()).match(/as unknown as Repo\b/g) ?? []).length
    }
  }
  expect(count).toBeLessThanOrEqual(MAX)
})
