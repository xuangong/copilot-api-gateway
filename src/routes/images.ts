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

/**
 * Elysia parses multipart/form-data into a plain object where fields are
 * strings and file parts are Blobs (or File). The "original" filename is
 * available on File instances. We reconstruct a FormData for forwarding.
 */
type MultipartBody = Record<string, string | Blob | File | undefined>

interface ImagesRouteContext {
  state: AppState
  body: GenerationsPayload | MultipartBody | unknown
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
    { operationName: "create image", enabledFlags: binding.enabledFlags },
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
  const { state, body, request, apiKeyId, colo, requestId } = ctx
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

  // Check content-type. Elysia will have already parsed the body if content-type is multipart.
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "/images/edits requires multipart/form-data" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  // Elysia parses multipart into a plain object { field: string | Blob | File }.
  // We use that parsed object to extract `model` and then reconstruct a FormData for upstream.
  const parsed = body as MultipartBody
  if (!parsed || typeof parsed !== "object") {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "failed to parse multipart body" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  const model = typeof parsed.model === "string" ? parsed.model : null
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

  // Reconstruct FormData from the parsed object so files (Blobs) are forwarded verbatim.
  // Bun's fetch() will generate the correct multipart boundary when body is FormData.
  const form = new FormData()
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue
    if (value instanceof File) {
      form.append(key, value, value.name)
    } else if (value instanceof Blob) {
      // Elysia may give us Blob without a name; use the field name as filename fallback.
      form.append(key, value, key)
    } else {
      form.append(key, String(value))
    }
  }

  // Forward the FormData verbatim. fetch() will set Content-Type with the correct boundary.
  const upstreamTimer = startTimer()
  const response = await binding.provider.fetch(
    "images_edits" as EndpointKey,
    { method: "POST", body: form },
    { operationName: "edit image", enabledFlags: binding.enabledFlags },
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
