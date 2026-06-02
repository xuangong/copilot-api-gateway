import { Elysia } from "elysia"

import { resolveBinding, stripUpstreamPin } from "~/lib/binding-resolver"
import { detectClient } from "~/lib/client-detect"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { checkQuota } from "~/lib/quota"
import type { AppState } from "~/lib/state"
import { trackNonStreamingUsage } from "~/middleware/usage"

interface EmbeddingsPayload {
  model: string
  input: string | string[] | number[] | number[][]
  encoding_format?: "float" | "base64"
  dimensions?: number
  user?: string
}

interface RouteContext {
  state: AppState
  body: EmbeddingsPayload
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
  userId?: string
}

interface EmbeddingsJson {
  usage?: { prompt_tokens?: number; total_tokens?: number }
}

async function handleEmbeddings(ctx: RouteContext): Promise<Response> {
  const { state, body, apiKeyId, colo, requestId, userAgent } = ctx
  const elapsed = startTimer()
  const client = detectClient(userAgent)

  if (apiKeyId) {
    const quota = await checkQuota(apiKeyId)
    if (!quota.allowed) {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (quota.retryAfterSeconds) headers["Retry-After"] = String(quota.retryAfterSeconds)
      return new Response(
        JSON.stringify({ error: { type: "rate_limit_error", message: quota.reason } }),
        { status: 429, headers },
      )
    }
  }

  stripUpstreamPin(body as unknown as Record<string, unknown>)
  const binding = await resolveBinding(state, ctx.userId, body.model, "embeddings")
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: `No embeddings upstream available for model: ${body.model}. Run GET /v1/models for available ids.` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }

  const upstreamTimer = startTimer()
  const response = await binding.provider.fetch(
    "embeddings",
    { method: "POST", body: JSON.stringify(body) },
    { operationName: "create embeddings" },
  )
  const upstreamMs = upstreamTimer()

  const json = (await response.json()) as EmbeddingsJson

  if (apiKeyId) {
    await trackNonStreamingUsage(json, apiKeyId, body.model, client, binding.upstream)
    recordLatency(apiKeyId, body.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: 0,
      sourceApi: "embeddings",
      targetApi: "embeddings",
      upstream: binding.upstream,
    }).catch(() => {})
  }

  return new Response(JSON.stringify(json), {
    headers: { "Content-Type": "application/json" },
  })
}

export const embeddingsRoute = new Elysia()
  .post("/embeddings", (ctx) => handleEmbeddings(ctx as unknown as RouteContext))
  .post("/v1/embeddings", (ctx) => handleEmbeddings(ctx as unknown as RouteContext))
