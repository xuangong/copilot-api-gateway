/**
 * Provider-specific behavior belongs to the provider plugin (LlmProviderPlugin
 * hooks: publicConfig, normalizeConfig, probeConfig, backup, catalog,
 * opaqueAffinity, syncView), not to `if (provider === "copilot")` in the
 * gateway — otherwise every new provider means editing the gateway, and a
 * missed edit silently mis-handles it.
 *
 * Ratchet: the count of provider-kind literal comparisons in gateway source
 * may only go down. Every remaining one is accounted for:
 *
 * - Identity checks in routes that exist only for one provider — "is this row
 *   really a Loki / Codex / Copilot row?" before acting on it:
 *   control-plane/loki/{routes,sync}.ts, upstreams/codex-quota-routes.ts,
 *   upstreams/codex-credentials-routes.ts, lib/github.ts (Copilot mirror),
 *   quota-balance/credential.ts (is this row a Copilot row with a stored credential, for quota reads and group membership).
 * - Copilot's request-scoped credential flows, which exist because Copilot
 *   alone can authenticate a request without a stored row:
 *   data-plane/providers/registry.ts (fallback token), control-plane/auth/
 *   session-auth.ts (session prewarm), tools/web-search/key-config.ts
 *   (borrowing a Copilot token for Copilot-hosted search),
 *   shared/affinity/shared-session-target.ts (GitHub-identity session key).
 * - Copilot variant composition when validating API-key model mappings
 *   (control-plane/api-keys/routes.ts) and the Copilot-specific probe and
 *   delete cascade into github_accounts (control-plane/upstreams/routes.ts).
 *
 * Anything new should be a plugin hook instead; lower MAX when one goes away.
 */
import { expect, test } from "bun:test"
import { Glob } from "bun"
import { join } from "node:path"

const MAX = 17
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
