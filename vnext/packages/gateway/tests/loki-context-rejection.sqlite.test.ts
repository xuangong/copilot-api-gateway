import { expect, test } from "bun:test"
import { setupTestPlatform } from "./_setup-platform"
import { app } from "../src/app"
import { _clearModelsMemoForTest } from "../src/data-plane/providers/registry"
import { __resetPlatformForTests } from "@vibe-core/platform"
import type { UserId } from "../src/repo/branded-ids"

// Claude Code only compacts when a 400/413 says the prompt is too long. Loki
// hides that wording, so the gateway must relabel its rejections end to end.
test("Loki context rejections reach Claude Code as prompt-too-long through the Messages route", async () => {
  const { db, repo } = setupTestPlatform()
  const originalFetch = globalThis.fetch
  const owner = "loki-context-owner" as UserId
  const now = new Date().toISOString()
  const baseUrl = "https://loki.example/api"
  let upstream: Response = new Response(null)
  try {
    await repo.users.create({ id: owner, name: "Fixture", disabled: false, createdAt: now })
    await repo.apiKeys.save({ id: "loki-context-key", name: "fixture", key: "loki-context-fixture-key", ownerId: owner,
      modelMappingsEnabled: false, modelMappings: [], createdAt: now })
    const account = { homeAccountId: "fixture-home", tenantId: "11111111-1111-4111-8111-111111111111" }
    await repo.upstreams.save({ id: "loki-context-fixture", provider: "loki", ownerId: owner, name: "Loki fixture", enabled: true,
      sortOrder: 0, config: { profileId: "loki-df-v1", baseUrl }, flagOverrides: {}, disabledPublicModelIds: [],
      proxyFallbackList: [{ id: "direct_fetch" }], createdAt: now, updatedAt: now,
      state: { version: 1, profileId: "loki-df-v1", generation: "fixture-generation", revision: 1,
        syncSecretHash: "fixture-hash", assistantStatus: "authorized", account,
        credential: { accessToken: "loki-upstream-fixture-token", tokenType: "Bearer", account, expiresAt: Date.now() + 3_600_000 } },
    })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `${baseUrl}/models`) return Response.json({ data: [{ id: "claude-opus-5.5", supported_endpoints: ["/v1/messages"],
        capabilities: { limits: { max_context_window_tokens: 1_000 } } }] })
      expect(url).toBe(`${baseUrl}/v1/messages`)
      return upstream
    }) as typeof fetch

    const send = async (chars: number) => {
      const response = await app.request("https://gateway.example/v1/messages", { method: "POST",
        headers: { authorization: "Bearer loki-context-fixture-key", "content-type": "application/json", "X-ConversationId": "fixture" },
        body: JSON.stringify({ model: "claude-opus-5.5", max_tokens: 64, stream: true,
          messages: [{ role: "user", content: "a".repeat(chars) }] }) })
      return { status: response.status, body: await response.json() as { error: { code?: string; message: string } } }
    }

    upstream = Response.json({ error: { message: "The request text exceeds the configured prompt data protection scan limit.",
      type: "invalid_request_error", code: "prompt_dlp_content_too_large" } }, { status: 413 })
    const dlp = await send(100)
    expect(dlp.status).toBe(413)
    expect(dlp.body.error).toMatchObject({ code: "prompt_dlp_content_too_large", message: "capability_rejected: prompt_too_long" })

    const generic = { error: { message: "Upstream rejected the request.", type: "invalid_request_error", code: "invalid_body" } }
    upstream = Response.json(generic, { status: 400 })
    const overflow = await send(2_600)
    expect(overflow.status).toBe(400)
    expect(overflow.body.error).toMatchObject({ code: "invalid_body", message: "capability_rejected: prompt_too_long" })

    upstream = Response.json(generic, { status: 400 })
    const small = await send(100)
    expect(small).toEqual({ status: 400, body: generic })
  } finally {
    globalThis.fetch = originalFetch
    _clearModelsMemoForTest()
    __resetPlatformForTests()
    db.close()
  }
})
