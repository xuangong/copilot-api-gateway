import { expect, test } from "bun:test"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import type { ProviderRequest } from "@vibe-llm/provider-llm"
import { LokiProvider } from "../provider"
import { normalizeLokiModels } from "../models"
import type { LokiState } from "../state"

// Loki replaces every Anthropic 400 with this generic body, and runs its own
// DLP scan before the model sees the request. Both shapes are copied from
// production responses.
const GENERIC_REJECTION = { error: { message: "Upstream rejected the request.", type: "invalid_request_error", code: "invalid_body" } }
const DLP_REJECTION = { error: { message: "The request text exceeds the configured prompt data protection scan limit.",
  type: "invalid_request_error", code: "prompt_dlp_content_too_large" } }
const PROMPT_TOO_LONG = "capability_rejected: prompt_too_long"

function provider(respond: () => Response, contextWindow: number | null = 1_000) {
  const state: LokiState = { version: 1, profileId: "loki-df-v1", generation: "generation", revision: 1,
    syncSecretHash: "hash", assistantStatus: "authorized", account: { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" },
    credential: { accessToken: "test-private-token", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000,
      account: { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" } } }
  const row: StoredUpstreamRecord<LokiState> = { id: "up_loki", rowIncarnation: "incarnation", ownerId: "owner", provider: "loki",
    name: "Loki", enabled: true, sortOrder: 0, config: { profileId: "loki-df-v1" }, state,
    catalogGeneration: 0, credentialGeneration: 0, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "", updatedAt: "" }
  const loki = new LokiProvider(row, async () => row, async () => respond())
  loki.setModelCatalog(normalizeLokiModels({ data: [
    { id: "claude-opus-5.5", supported_endpoints: ["/v1/messages"],
      capabilities: { limits: contextWindow === null ? {} : { max_context_window_tokens: contextWindow } } },
    { id: "gpt-6-sol", supported_endpoints: ["/responses"], capabilities: { limits: { max_context_window_tokens: 1_000 } } },
  ] }))
  return loki
}

// 2,600 ASCII characters estimate to 1,000 tokens.
const messages = (chars: number, endpoint: ProviderRequest["endpoint"] = "messages"): ProviderRequest => ({
  endpoint, headers: new Headers(), sourceApi: "anthropic",
  payload: endpoint === "messages"
    ? { model: "claude-opus-5.5", max_tokens: 64, messages: [{ role: "user", content: "a".repeat(chars) }] }
    : { model: "gpt-6-sol", input: "a".repeat(chars) },
})

const read = async (response: { status: number; body: ReadableStream<Uint8Array> | null }) =>
  ({ status: response.status, text: await new Response(response.body).text() })

test("Loki's DLP scan limit becomes a prompt-too-long rejection Claude Code can compact", async () => {
  const result = await read(await provider(() => Response.json(DLP_REJECTION, { status: 413 })).fetch(messages(100)))
  expect(result.status).toBe(413)
  expect(JSON.parse(result.text)).toEqual({ type: "error",
    error: { type: "invalid_request_error", code: "prompt_dlp_content_too_large", message: PROMPT_TOO_LONG } })
})

test("a generic rejection of a request near the context window is classified as prompt too long", async () => {
  // 70% of the 1,000-token window is the smallest size treated as an overflow.
  const result = await read(await provider(() => Response.json(GENERIC_REJECTION, { status: 400 })).fetch(messages(1_820)))
  expect(result.status).toBe(400)
  expect(JSON.parse(result.text)).toEqual({ type: "error",
    error: { type: "invalid_request_error", code: "invalid_body", message: PROMPT_TOO_LONG } })
})

test("a generic rejection of a small request keeps Loki's original body", async () => {
  const body = JSON.stringify(GENERIC_REJECTION)
  const result = await read(await provider(() => new Response(body, { status: 400 })).fetch(messages(1_800)))
  expect(result).toEqual({ status: 400, text: body })
})

test("a generic rejection is not reclassified when the model's context window is unknown", async () => {
  const body = JSON.stringify(GENERIC_REJECTION)
  const result = await read(await provider(() => new Response(body, { status: 400 }), null).fetch(messages(100_000)))
  expect(result).toEqual({ status: 400, text: body })
})

test("Anthropic's own prompt-too-long wording is relayed byte for byte", async () => {
  const body = JSON.stringify({ type: "error",
    error: { type: "invalid_request_error", message: "prompt is too long: 1003456 tokens > 1000000 maximum" } })
  const result = await read(await provider(() => new Response(body, { status: 400 })).fetch(messages(100_000)))
  expect(result).toEqual({ status: 400, text: body })
})

test("other statuses, non-JSON bodies and other endpoints are left alone", async () => {
  for (const [response, request] of [
    [() => new Response("Missing required header 'X-ConversationId'.", { status: 400 }), messages(100_000)],
    [() => Response.json(GENERIC_REJECTION, { status: 500 }), messages(100_000)],
    [() => Response.json({ error: { code: "body_too_large", message: "Request body too large." } }, { status: 413 }), messages(100_000)],
    [() => Response.json(DLP_REJECTION, { status: 413 }), messages(100_000, "responses")],
  ] as const) {
    const expected = await response().text()
    const result = await read(await provider(response).fetch(request))
    expect(result.text).toBe(expected)
  }
})
