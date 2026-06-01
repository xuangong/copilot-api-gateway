import { Elysia } from "elysia"

import { resolveBinding, stripUpstreamPin } from "~/lib/binding-resolver"
import { detectClient } from "~/lib/client-detect"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { checkQuota } from "~/lib/quota"
import type { AppState } from "~/lib/state"
import type { EndpointKey } from "~/protocols/common"

interface GenerationsPayload {
  model: string
  prompt?: string
  n?: number
  size?: string
  response_format?: string
  user?: string
}

interface ImagesRouteContext {
  state: AppState
  body: GenerationsPayload | unknown
  request: Request
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
  userId?: string
}

async function handleGenerations(ctx: ImagesRouteContext): Promise<Response> {
  const { state, body, apiKeyId, colo, requestId, userAgent } = ctx
  const elapsed = startTimer()
  detectClient(userAgent)

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

  const payload = body as GenerationsPayload
  if (!payload || typeof payload.model !== "string") {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "model is required" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  stripUpstreamPin(payload as unknown as Record<string, unknown>)
  const binding = await resolveBinding(state, ctx.userId, payload.model, "images_generations")
  if (!binding) {
    return new Response(
      JSON.stringify({
        error: { type: "invalid_request_error", message: `No images_generations upstream available for model: ${payload.model}. Run GET /v1/models for available ids.` },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }

  const upstreamTimer = startTimer()
  const response = await binding.provider.fetch(
    "images_generations" as EndpointKey,
    { method: "POST", body: JSON.stringify(payload) },
    { operationName: "create image" },
  )
  const upstreamMs = upstreamTimer()

  // Images responses don't carry token usage — record only latency, no usage tracking.
  if (apiKeyId) {
    recordLatency(apiKeyId, payload.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: 0,
      outputTokens: 0,
      upstream: binding.upstream,
    }).catch(() => {})
  }

  // Forward raw response (status + headers + body) so the caller sees what upstream sent.
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}

async function handleEdits(ctx: ImagesRouteContext): Promise<Response> {
  const { state, request, apiKeyId, colo, requestId } = ctx
  const elapsed = startTimer()

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

  // Re-read multipart so we can extract `model` without consuming the original body twice.
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "/images/edits requires multipart/form-data" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  // Bun's Request supports formData() and we can rebuild a fresh body for the upstream call.
  // formData() consumes the body, so we reconstruct a FormData when forwarding.
  let form: FormData
  try {
    form = await request.formData()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: `failed to parse multipart: ${msg}` } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  const modelField = form.get("model")
  const model = typeof modelField === "string" ? modelField : null
  if (!model) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "model field is required in multipart body" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  const binding = await resolveBinding(state, ctx.userId, model, "images_edits")
  if (!binding) {
    return new Response(
      JSON.stringify({
        error: { type: "invalid_request_error", message: `No images_edits upstream available for model: ${model}. Run GET /v1/models for available ids.` },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }

  // Forward the FormData verbatim. fetch() will set Content-Type with the correct boundary.
  const upstreamTimer = startTimer()
  const response = await binding.provider.fetch(
    "images_edits" as EndpointKey,
    { method: "POST", body: form },
    { operationName: "edit image" },
  )
  const upstreamMs = upstreamTimer()

  if (apiKeyId) {
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: 0,
      outputTokens: 0,
      upstream: binding.upstream,
    }).catch(() => {})
  }

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}

export const imagesRoute = new Elysia()
  .post("/images/generations", (ctx) => handleGenerations(ctx as unknown as ImagesRouteContext))
  .post("/v1/images/generations", (ctx) => handleGenerations(ctx as unknown as ImagesRouteContext))
  .post("/images/edits", (ctx) => handleEdits(ctx as unknown as ImagesRouteContext))
  .post("/v1/images/edits", (ctx) => handleEdits(ctx as unknown as ImagesRouteContext))
