/**
 * Provider-specific behavior belongs to the provider plugin (LlmProviderPlugin
 * hooks: publicConfig, normalizeConfig, probeConfig, backup, catalog,
 * opaqueAffinity, syncView), not to `if (provider === "copilot")` in the
 * gateway — otherwise every new provider means editing the gateway, and a
 * missed edit silently mis-handles it.
 *
 * Ratchet: the count of provider-kind literal comparisons in gateway source
 * may only go down. What remains is mostly identity checks in provider-owned
 * control-plane routes (Loki sync, Codex credentials) and Copilot's
 * request-scoped token fallback.
 */
import { expect, test } from "bun:test"
import { Glob } from "bun"
import { join } from "node:path"

const MAX = 20
const SRC = join(import.meta.dir, "../../src")
const KIND_COMPARISON = /(?:provider|kind)\s*[!=]==\s*['"](?:copilot|codex|claude-code|custom|azure|loki|sdf)['"]/g

test("gateway source does not grow provider-kind branches", async () => {
  const hits: string[] = []
  for await (const rel of new Glob("**/*.ts").scan(SRC)) {
    if (rel.includes("__tests__") || rel.endsWith(".test.ts")) continue
    const text = await Bun.file(join(SRC, rel)).text()
    for (const match of text.matchAll(KIND_COMPARISON)) hits.push(`${rel}: ${match[0]}`)
  }
  expect(hits.length, hits.join("\n")).toBeLessThanOrEqual(MAX)
})
