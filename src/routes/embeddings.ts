import { Elysia } from "elysia"

import { detectClient } from "~/lib/client-detect"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { checkQuota } from "~/lib/quota"
import type { AppState } from "~/lib/state"
import { trackNonStreamingUsage } from "~/middleware/usage"
import { createCopilotProvider } from "~/providers/registry"

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
      return new Response(
        JSON.stringify({ error: { type: "rate_limit_error", message: quota.reason } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      )
    }
  }

  const provider = createCopilotProvider({ copilotToken: state.copilotToken, accountType: state.accountType })
  const upstreamTimer = startTimer()
  const response = await provider.callEmbeddings(
    body as unknown as Record<string, unknown>,
    { operationName: "create embeddings" },
  )
  const upstreamMs = upstreamTimer()

  const json = (await response.json()) as EmbeddingsJson

  if (apiKeyId) {
    await trackNonStreamingUsage(json, apiKeyId, body.model, client, state.upstream)
    recordLatency(apiKeyId, body.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: 0,
      sourceApi: "embeddings",
      targetApi: "embeddings",
      upstream: state.upstream,
    }).catch(() => {})
  }

  return new Response(JSON.stringify(json), {
    headers: { "Content-Type": "application/json" },
  })
}

export const embeddingsRoute = new Elysia()
  .post("/embeddings", (ctx) => handleEmbeddings(ctx as unknown as RouteContext))
  .post("/v1/embeddings", (ctx) => handleEmbeddings(ctx as unknown as RouteContext))
