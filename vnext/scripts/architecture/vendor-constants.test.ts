/**
 * Every pinned vendor constant — client versions, user agents, OAuth client
 * ids, beta flags, upstream origins — carries a source link in the comment
 * above it. These values imitate or address someone else's system; when one
 * breaks (a version is rejected, a beta is renamed) the link is how to
 * re-verify it. Rule taken from reference copilot-gateway AGENTS.md
 * ("Vendor constants: attach a reference URL to every vendor constant").
 */
import { expect, test } from "bun:test"
import { Glob } from "bun"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../packages")
const VENDOR_CONSTANT = /^export const ([A-Z][A-Z0-9_]*(?:VERSION|USER_AGENT|CLIENT_ID|BETA|BASE_URL|API_BASE|ORIGIN|ENDPOINT)[A-Z0-9_]*)\s*=\s*[`"']/
const LOOKBACK = 12

test("vendor constants in provider packages cite their source", async () => {
  const missing: string[] = []
  for await (const rel of new Glob("provider-*/src/**/*.ts").scan(ROOT)) {
    if (rel.includes("__tests__")) continue
    const lines = (await Bun.file(join(ROOT, rel)).text()).split("\n")
    lines.forEach((line, i) => {
      const match = VENDOR_CONSTANT.exec(line)
      if (!match) return
      const context = lines.slice(Math.max(0, i - LOOKBACK), i + 1).join("\n")
      if (!context.includes("https://")) missing.push(`${rel}:${i + 1} ${match[1]}`)
    })
  }
  expect(missing).toEqual([])
})
