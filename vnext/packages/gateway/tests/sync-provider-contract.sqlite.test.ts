import { afterEach, expect, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { setupTestPlatform } from "./_setup-platform"
import { createFetchStub } from '@vibe-core/test-utils'
import { _clearModelsMemoForTest, createProviderFromUpstream, isSyncableProvider, providerPlugin } from "../src/data-plane/providers/registry"

// Restores the global fetch after every test in this file.
const stubGlobalFetch = createFetchStub()

afterEach(() => { _clearModelsMemoForTest(); __resetPlatformForTests() })

const stamp = "2026-11-16T00:00:00.000Z"
const account = { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" }
const base = { ownerId: "device-owner", enabled: true, sortOrder: 0, flagOverrides: {}, disabledPublicModelIds: [],
  proxyFallbackList: [], createdAt: stamp, updatedAt: stamp }
const urlOf = (input: URL | RequestInfo) => String(input instanceof Request ? input.url : input)

test("only copilot and loki declare syncable", () => {
  for (const kind of ["copilot", "loki"]) expect(isSyncableProvider(kind)).toBe(true)
  for (const kind of ["custom", "azure", "sdf", "codex", "claude-code", "unknown"]) expect(isSyncableProvider(kind)).toBe(false)
  expect(providerPlugin("copilot")?.kind).toBe("copilot")
  expect(providerPlugin("nope")).toBeUndefined()
})

test("a synced Copilot upstream lists models without writing stored credentials or state", async () => {
  const { repo } = setupTestPlatform()
  await repo.upstreams.save({ ...base, id: "up_copilot_synced", provider: "copilot", name: "Synced Copilot",
    config: { githubToken: "ghp_synced_readonly_fixture", accountType: "individual" }, state: null })
  const stored = (await repo.upstreams.getById("up_copilot_synced" as never))!
  const writes: string[] = []
  for (const name of ["saveState", "replaceCredentials", "patchMetadata", "save", "createIfAbsent", "delete", "deleteAll"] as const) {
    const original = (repo.upstreams[name] as (...args: unknown[]) => Promise<unknown>).bind(repo.upstreams)
    ;(repo.upstreams as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => { writes.push(name); return original(...args) }
  }
  stubGlobalFetch(async input => {
    const url = urlOf(input)
    if (url.endsWith("/copilot_internal/v2/token")) {
      return Response.json({ token: "session-token", expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 1500,
        endpoints: { api: "https://api.githubcopilot.com" } })
    }
    if (url.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "gpt-4o", object: "model", name: "gpt-4o", vendor: "openai", version: "gpt-4o",
        model_picker_enabled: true, preview: false, capabilities: { family: "gpt-4o", limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 }, object: "model_capabilities",
          supports: {}, tokenizer: "o200k_base", type: "chat" } }] })
    }
    throw new Error(`unexpected egress ${url}`)
  })
  const plugin = providerPlugin("copilot")!
  const seen: unknown[] = []
  const original = plugin.createFromUpstream.bind(plugin)
  plugin.createFromUpstream = (upstream, ctx) => { seen.push(ctx.credentialsReadOnly); return original(upstream, ctx) }
  try {
    const synced = { ...stored, syncSourceId: "ssrc_fixture" } as StoredUpstreamRecord
    const provider = await createProviderFromUpstream(synced)
    expect((await provider!.getModels()).data.map(model => model.id)).toEqual(["gpt-4o"])
    await createProviderFromUpstream(stored)
    expect(seen).toEqual([true, false])
    expect(writes).toEqual([])
  } finally { plugin.createFromUpstream = original }
})

test("a synced Loki upstream serves from the synced credential and a plain one without a pairing secret does not", async () => {
  const { repo } = setupTestPlatform()
  const state = { version: 1, profileId: "loki-df-v1", generation: "g", revision: 1, assistantStatus: "authorized", account,
    credential: { accessToken: "central-token", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000, account } }
  await repo.upstreams.save({ ...base, id: "up_loki_synced", provider: "loki", name: "Synced Loki",
    config: { profileId: "loki-df-v1" }, state })
  const stored = (await repo.upstreams.getById("up_loki_synced" as never))!
  const bearers: string[] = []
  stubGlobalFetch(async (input) => {
    bearers.push(input.headers.get("authorization") ?? "")
    expect(urlOf(input)).toBe("https://loki.delve.office.com/api/v1/llmapi/models")
    return Response.json({ data: [{ id: "claude-opus-5.5", supported_endpoints: ["/v1/messages"] }] })
  })
  const synced = await createProviderFromUpstream({ ...stored, syncSourceId: "ssrc_fixture" } as StoredUpstreamRecord)
  expect((await synced!.getModels()).data.map(model => model.id)).toEqual(["claude-opus-5.5"])
  expect(bearers).toEqual(["Bearer central-token"])
  const plain = await createProviderFromUpstream(stored)
  await expect(plain!.getModels()).rejects.toThrow("loki_credential_unavailable")
})
