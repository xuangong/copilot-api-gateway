/**
 * Provider-specific backup rules (export redaction, import validation,
 * restore). Characterization for moving them from the gateway into provider
 * plugins: the behavior must not change.
 */
import { expect, test } from "bun:test"
import { exportConfig, parseConfigBundle, unredactWithLive } from "../../src/control-plane/lib/import-export.ts"
import type { UpstreamRecord } from "../../src/repo/types.ts"

// Keys are model ids and may contain words such as "token"; Azure keys name a surface.
const DECLARATIONS: Record<string, Record<string, unknown>> = {
  custom: { "token-model": { version: 1, key: "declared-a", scope: "owner" } },
  azure: { "openai:token-deployment": { version: 1, key: "declared-a", scope: "owner" } },
}
const declaration = DECLARATIONS.custom
const row = (provider: string, config: Record<string, unknown>, id = `up_${provider}`): UpstreamRecord<unknown> =>
  ({ id, provider, name: id, enabled: true, sortOrder: 0, config, flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: "t", updatedAt: "t" }) as UpstreamRecord<unknown>
const bundle = (upstreams: UpstreamRecord<unknown>[]) => ({ version: 2, apiKeys: [], githubAccounts: [], upstreams })

test.each(["custom", "azure"])("%s: a redacted export keeps the opaque compatibility declaration verbatim", provider => {
  const out = exportConfig({ apiKeys: [], githubAccounts: [], upstreams: [row(provider, { apiKey: "secret-value", opaqueCompatibility: DECLARATIONS[provider] })] }, { redactSecrets: true })
  const config = out.upstreams[0]!.config as Record<string, unknown>
  expect(config.apiKey).not.toBe("secret-value")
  expect(config.opaqueCompatibility).toEqual(DECLARATIONS[provider])
})

test.each(["custom", "azure"])("%s: importing a malformed declaration is refused", provider => {
  expect(() => parseConfigBundle(bundle([row(provider, { opaqueCompatibility: { m: { version: 99 } } })]))).toThrow()
})

test.each(["copilot", "custom", "azure"])("%s rows can be imported", provider => {
  expect(parseConfigBundle(bundle([row(provider, {})])).bundle.upstreams).toHaveLength(1)
})

test.each(["codex", "claude-code", "sdf", "nope"])("%s rows are refused on import", provider => {
  expect(() => parseConfigBundle(bundle([row(provider, {})]))).toThrow(/unsupported provider/)
})

test("restoring a redacted custom row keeps the imported declaration", () => {
  const live = row("custom", { apiKey: "secret-value", opaqueCompatibility: declaration })
  const redacted = exportConfig({ apiKeys: [], githubAccounts: [], upstreams: [live] }, { redactSecrets: true })
  const parsed = parseConfigBundle(redacted).bundle
  const merged = unredactWithLive(parsed, { apiKeys: [], githubAccounts: [], upstreams: [live] })
  expect(merged.upstreams[0]!.config).toMatchObject({ apiKey: "secret-value", opaqueCompatibility: declaration })
})
