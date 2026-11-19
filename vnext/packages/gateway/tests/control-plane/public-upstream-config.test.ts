/**
 * The dashboard DTO is a security boundary: each provider exposes an
 * allowlist of config fields and masks credentials. These fixtures put a
 * secret (`LEAK-…`) in every credential slot and in extra, non-allowlisted
 * fields, then pin the exact projection, so moving the projection between
 * packages cannot widen it.
 */
import { expect, test } from "bun:test"
import type { UpstreamKind } from "@vibe-llm/protocols/common"
import { publicUpstreamConfig } from "../../src/control-plane/upstreams/public-dto.ts"
import type { UpstreamRecord } from "../../src/repo/types.ts"

const row = (provider: UpstreamKind, config: Record<string, unknown>) =>
  ({ id: `up_${provider}`, provider, name: provider, enabled: true, sortOrder: 0, config, flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: "", updatedAt: "" }) as UpstreamRecord<unknown>

const extra = { privateNote: "LEAK-extra", nested: { token: "LEAK-nested" } }

const FIXTURES: Record<UpstreamKind, Record<string, unknown>> = {
  copilot: { ...extra, githubToken: "LEAK-gh", accountType: "business", githubHost: "acme.ghe.com", source: "device-flow",
    user: { id: 7, login: "alice", name: "Alice", avatar_url: "https://a/x.png", email: "LEAK-email" } },
  custom: { ...extra, name: "c", baseUrl: "https://c.test", authStyle: "bearer", modelsEndpoint: "/models", apiKey: "LEAK-key",
    endpoints: ["chat_completions", 3], defaultHeaders: { "x-secret": "LEAK-header" },
    pathOverrides: { messages: "/anthropic/v1/messages", bogus: "LEAK-path" },
    models: ["plain", { id: "m", name: "M", ownedBy: "o", upstreamModelId: "u", secret: "LEAK-model", cost: { input: 1, bogus: "x" } }] },
  azure: { ...extra, name: "a", endpoint: "https://a.test", deployment: "d", apiVersion: "2025-01-01", apiKey: "LEAK-key",
    deployments: [{ name: "d1", model: "gpt", key: "LEAK-dep" }], endpoints: ["chat_completions"] },
  sdf: { ...extra, name: "s", substrateToken: "LEAK-substrate",
    taxonomy: { experience: "BizChat", agent: "a", inferenceStep: "i", trafficType: "Test", secret: "LEAK-tax" },
    cos: { serviceTier: "flex", key: "LEAK-cos" }, passport: { enabled: true, apiBase: "https://p.test", token: "LEAK-pass" } },
  codex: { ...extra, accounts: [{ email: "e@x", chatgptAccountId: "acc", chatgptUserId: "usr", planType: "plus", refresh_token: "LEAK-refresh", accessToken: { token: "LEAK-access" } }] },
  "claude-code": { ...extra, accounts: [{ email: "e@x", accountUuid: "u", organizationUuid: "o", subscriptionType: "max", rateLimitTier: "t", refreshToken: "LEAK-refresh" }] },
  loki: { ...extra, profileId: "p", baseUrl: "https://l.test", credential: "LEAK-cred" },
}

test.each(Object.keys(FIXTURES) as UpstreamKind[])("%s config projection never contains a fixture secret", kind => {
  expect(JSON.stringify(publicUpstreamConfig(row(kind, FIXTURES[kind])))).not.toContain("LEAK-")
})

test("projections are exactly the allowlisted fields", () => {
  const out = Object.fromEntries((Object.keys(FIXTURES) as UpstreamKind[]).map(kind => [kind, publicUpstreamConfig(row(kind, FIXTURES[kind]))]))
  expect(out).toEqual(EXPECTED)
})

const EXPECTED: Record<string, unknown> = {
  copilot: {
    accountType: "business",
    githubHost: "acme.ghe.com",
    source: "device-flow",
    githubToken: "***",
    user: {
      id: 7,
      login: "alice",
      name: "Alice",
      avatar_url: "https://a/x.png",
    },
  },
  custom: {
    name: "c",
    baseUrl: "https://c.test",
    authStyle: "bearer",
    modelsEndpoint: "/models",
    pathOverrides: {
      messages: "/anthropic/v1/messages",
    },
    models: ["plain", {
      id: "m",
      name: "M",
      ownedBy: "o",
      upstreamModelId: "u",
      cost: {
        input: 1,
      },
    }],
    apiKey: "***",
    endpoints: ["chat_completions"],
    defaultHeaders: {
      "x-secret": "***",
    },
  },
  azure: {
    name: "a",
    endpoint: "https://a.test",
    deployment: "d",
    apiVersion: "2025-01-01",
    deployments: [{
      name: "d1",
      model: "gpt",
    }],
    apiKey: "***",
    endpoints: ["chat_completions"],
  },
  sdf: {
    name: "s",
    substrateToken: "***",
    taxonomy: {
      experience: "BizChat",
      agent: "a",
      inferenceStep: "i",
      trafficType: "Test",
    },
    cos: {
      serviceTier: "flex",
    },
    passport: {
      enabled: true,
      apiBase: "https://p.test",
    },
  },
  codex: {
    accounts: [{
      email: "e@x",
      chatgptAccountId: "acc",
      chatgptUserId: "usr",
      planType: "plus",
    }],
  },
  "claude-code": {
    accounts: [{
      email: "e@x",
      accountUuid: "u",
      organizationUuid: "o",
      subscriptionType: "max",
      rateLimitTier: "t",
    }],
  },
  loki: {
    profileId: "p",
    baseUrl: "https://l.test",
  },
}
