import { test, expect, describe } from "bun:test"
import {
  CONFIG_BUNDLE_VERSION,
  REDACTED,
  exportConfig,
  parseConfigBundle,
  unredactWithLive,
} from "~/config/import-export"
import type { ApiKey, GitHubAccount, UpstreamRecord } from "~/repo/types"

const sampleKey: ApiKey = {
  id: "k1",
  name: "primary",
  key: "sk-live-abc",
  createdAt: "2026-01-01T00:00:00Z",
  webSearchEnabled: true,
  webSearchLangsearchKey: "ls-secret",
  webSearchTavilyKey: "tv-secret",
  webSearchMsGroundingKey: "ms-secret",
}

const sampleAccount: GitHubAccount = {
  token: "gho_live",
  accountType: "individual",
  user: { id: 42, login: "octocat", name: "Octo", avatar_url: "https://x" },
}

const sampleUpstream: UpstreamRecord = {
  id: "u_custom_1",
  provider: "custom",
  name: "Internal proxy",
  enabled: true,
  sortOrder: 10,
  config: {
    baseUrl: "https://proxy.internal/v1",
    apiKey: "sk-upstream-secret",
    defaultHeaders: { Authorization: "Bearer abc", "X-Tenant": "team-a" },
    models: ["gpt-4o", "gpt-4o-mini"],
  },
  flagOverrides: { "transform-strip-thinking": true },
  disabledPublicModelIds: ["gpt-3.5-turbo"],
  createdAt: "2026-04-01T00:00:00Z",
  updatedAt: "2026-04-02T00:00:00Z",
}

describe("exportConfig", () => {
  test("round-trip without redaction preserves secrets", () => {
    const bundle = exportConfig(
      { apiKeys: [sampleKey], githubAccounts: [sampleAccount] },
      { now: "2026-05-25T00:00:00Z" },
    )
    expect(bundle.version).toBe(CONFIG_BUNDLE_VERSION)
    expect(bundle.exportedAt).toBe("2026-05-25T00:00:00Z")
    expect(bundle.apiKeys[0].key).toBe("sk-live-abc")
    expect(bundle.apiKeys[0].webSearchLangsearchKey).toBe("ls-secret")
    expect(bundle.githubAccounts[0].token).toBe("gho_live")
  })

  test("redactSecrets masks api_key secrets and github token", () => {
    const bundle = exportConfig(
      { apiKeys: [sampleKey], githubAccounts: [sampleAccount] },
      { redactSecrets: true, now: "2026-05-25T00:00:00Z" },
    )
    expect(bundle.apiKeys[0].key).toBe(REDACTED)
    expect(bundle.apiKeys[0].webSearchLangsearchKey).toBe(REDACTED)
    expect(bundle.apiKeys[0].webSearchTavilyKey).toBe(REDACTED)
    expect(bundle.apiKeys[0].webSearchMsGroundingKey).toBe(REDACTED)
    expect(bundle.githubAccounts[0].token).toBe(REDACTED)
    expect(bundle.apiKeys[0].name).toBe("primary")
    expect(bundle.apiKeys[0].webSearchEnabled).toBe(true)
  })

  test("does not mutate input arrays", () => {
    const keys = [sampleKey]
    exportConfig({ apiKeys: keys, githubAccounts: [sampleAccount] }, { redactSecrets: true })
    expect(keys[0].key).toBe("sk-live-abc")
  })

  test("flagOverrides round-trip", () => {
    const bundle = exportConfig({
      apiKeys: [],
      githubAccounts: [],
      flagOverrides: { copilot: { foo: true }, azure: { bar: false } },
    })
    expect(bundle.flagOverrides?.copilot?.foo).toBe(true)
    expect(bundle.flagOverrides?.azure?.bar).toBe(false)
  })
})

describe("parseConfigBundle", () => {
  test("rejects payload without version", () => {
    expect(() => parseConfigBundle({ apiKeys: [], githubAccounts: [] })).toThrow(/Missing `version`/)
  })

  test("rejects mismatched version", () => {
    expect(() => parseConfigBundle({ version: 99, apiKeys: [], githubAccounts: [] })).toThrow(
      /Unsupported config bundle version/,
    )
  })

  test("rejects non-array apiKeys", () => {
    expect(() => parseConfigBundle({ version: 1, apiKeys: {}, githubAccounts: [] })).toThrow(
      /`apiKeys` must be an array/,
    )
  })

  test("rejects non-array githubAccounts", () => {
    expect(() => parseConfigBundle({ version: 1, apiKeys: [], githubAccounts: "x" })).toThrow(
      /`githubAccounts` must be an array/,
    )
  })

  test("rejects entries without id", () => {
    expect(() =>
      parseConfigBundle({ version: 1, apiKeys: [{ name: "x" }], githubAccounts: [] }),
    ).toThrow(/missing id/)
  })

  test("counts redacted entries", () => {
    const redactedKey: ApiKey = { ...sampleKey, key: REDACTED }
    const redactedAcct: GitHubAccount = { ...sampleAccount, token: REDACTED }
    const { redactedCount } = parseConfigBundle({
      version: 1,
      exportedAt: "now",
      apiKeys: [redactedKey],
      githubAccounts: [redactedAcct],
    })
    // sampleKey has 4 secret fields, only `key` is redacted here → 1, +1 for the gh token
    expect(redactedCount).toBe(2)
  })

  test("accepts a clean bundle round-trip", () => {
    const exported = exportConfig({ apiKeys: [sampleKey], githubAccounts: [sampleAccount] })
    const { bundle, redactedCount } = parseConfigBundle(JSON.parse(JSON.stringify(exported)))
    expect(bundle.version).toBe(CONFIG_BUNDLE_VERSION)
    expect(redactedCount).toBe(0)
  })

  test("rejects malformed flagOverrides", () => {
    expect(() =>
      parseConfigBundle({ version: 1, apiKeys: [], githubAccounts: [], flagOverrides: [] }),
    ).toThrow(/flagOverrides/)
  })

  test("v1 payload is lifted to v2 with empty upstreams", () => {
    const { bundle, sourceVersion } = parseConfigBundle({
      version: 1,
      exportedAt: "2026-04-01T00:00:00Z",
      apiKeys: [],
      githubAccounts: [],
    })
    expect(sourceVersion).toBe(1)
    expect(bundle.version).toBe(CONFIG_BUNDLE_VERSION)
    expect(bundle.upstreams).toEqual([])
  })

  test("v2 payload preserves upstreams", () => {
    const { bundle, sourceVersion } = parseConfigBundle({
      version: 2,
      exportedAt: "2026-04-01T00:00:00Z",
      apiKeys: [],
      githubAccounts: [],
      upstreams: [sampleUpstream],
    })
    expect(sourceVersion).toBe(2)
    expect(bundle.upstreams).toHaveLength(1)
    expect(bundle.upstreams[0].id).toBe("u_custom_1")
  })

  test("rejects upstream entry missing id", () => {
    expect(() =>
      parseConfigBundle({
        version: 2,
        apiKeys: [],
        githubAccounts: [],
        upstreams: [{ provider: "custom", name: "x", config: {} }],
      }),
    ).toThrow(/upstreams entry missing id/)
  })

  test("rejects upstream with unsupported provider", () => {
    expect(() =>
      parseConfigBundle({
        version: 2,
        apiKeys: [],
        githubAccounts: [],
        upstreams: [{ id: "u1", provider: "bogus", name: "x", config: {} }],
      }),
    ).toThrow(/unsupported provider/)
  })

  test("counts redacted secrets nested in upstream config", () => {
    const redacted = {
      ...sampleUpstream,
      config: { ...sampleUpstream.config, apiKey: REDACTED },
    }
    const { redactedCount } = parseConfigBundle({
      version: 2,
      apiKeys: [],
      githubAccounts: [],
      upstreams: [redacted],
    })
    expect(redactedCount).toBe(1)
  })
})

describe("upstream round-trip", () => {
  test("redactSecrets masks nested apiKey / Authorization header", () => {
    const bundle = exportConfig(
      { apiKeys: [], githubAccounts: [], upstreams: [sampleUpstream] },
      { redactSecrets: true, now: "2026-05-25T00:00:00Z" },
    )
    const cfg = bundle.upstreams[0].config as Record<string, unknown>
    expect(cfg.apiKey).toBe(REDACTED)
    const headers = cfg.defaultHeaders as Record<string, unknown>
    expect(headers.Authorization).toBe(REDACTED)
    expect(headers["X-Tenant"]).toBe("team-a")
    expect(cfg.baseUrl).toBe("https://proxy.internal/v1")
  })

  test("unredactWithLive restores nested upstream secrets matched by id", () => {
    const exported = exportConfig(
      { apiKeys: [], githubAccounts: [], upstreams: [sampleUpstream] },
      { redactSecrets: true },
    )
    const merged = unredactWithLive(exported, {
      apiKeys: [],
      githubAccounts: [],
      upstreams: [sampleUpstream],
    })
    const cfg = merged.upstreams[0].config as Record<string, unknown>
    expect(cfg.apiKey).toBe("sk-upstream-secret")
    const headers = cfg.defaultHeaders as Record<string, unknown>
    expect(headers.Authorization).toBe("Bearer abc")
  })

  test("unredactWithLive leaves upstream alone when no live match", () => {
    const exported = exportConfig(
      { apiKeys: [], githubAccounts: [], upstreams: [sampleUpstream] },
      { redactSecrets: true },
    )
    const merged = unredactWithLive(exported, {
      apiKeys: [],
      githubAccounts: [],
      upstreams: [],
    })
    const cfg = merged.upstreams[0].config as Record<string, unknown>
    expect(cfg.apiKey).toBe(REDACTED)
  })
})

describe("unredactWithLive", () => {
  test("restores REDACTED secrets from live state matched by id", () => {
    const exported = exportConfig(
      { apiKeys: [sampleKey], githubAccounts: [sampleAccount] },
      { redactSecrets: true },
    )
    const merged = unredactWithLive(exported, {
      apiKeys: [sampleKey],
      githubAccounts: [sampleAccount],
    })
    expect(merged.apiKeys[0].key).toBe("sk-live-abc")
    expect(merged.apiKeys[0].webSearchLangsearchKey).toBe("ls-secret")
    expect(merged.githubAccounts[0].token).toBe("gho_live")
  })

  test("keeps REDACTED when no live counterpart exists", () => {
    const exported = exportConfig(
      { apiKeys: [sampleKey], githubAccounts: [sampleAccount] },
      { redactSecrets: true },
    )
    const merged = unredactWithLive(exported, { apiKeys: [], githubAccounts: [] })
    expect(merged.apiKeys[0].key).toBe(REDACTED)
    expect(merged.githubAccounts[0].token).toBe(REDACTED)
  })

  test("non-redacted values pass through unchanged", () => {
    const exported = exportConfig({ apiKeys: [sampleKey], githubAccounts: [sampleAccount] })
    const merged = unredactWithLive(exported, {
      apiKeys: [{ ...sampleKey, key: "different" }],
      githubAccounts: [{ ...sampleAccount, token: "different" }],
    })
    expect(merged.apiKeys[0].key).toBe("sk-live-abc")
    expect(merged.githubAccounts[0].token).toBe("gho_live")
  })
})
