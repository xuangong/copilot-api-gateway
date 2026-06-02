/**
 * Responses `image_generation` server-tool shim (single-turn slice).
 *
 * Slice 2 scope: when a Responses request declares the hosted
 * `image_generation` tool, short-circuit the orchestrator entirely and
 * dispatch the user's prompt straight to the configured images backend.
 * Returns a Responses-shaped envelope whose single output item is an
 * `image_generation_call` carrying the resulting b64.
 *
 * ReAct multi-turn (model decides when to call), input_image edits, and
 * Azure-strict tool-config validation arrive in slice 3/4 — keeping this
 * slice small so it can ship as one commit.
 */

import type { ProviderBinding } from "~/providers/binding"
import type { EndpointKey } from "~/protocols/common"
import type {
  ResponseInputItem,
  ResponseTool,
  ResponsesPayload,
} from "~/transforms"

export const SHIM_TOOL_NAME = "image_generation"

/**
 * Default backend model when the hosted tool omits `model`. Operators
 * provision the gpt-image-2 backend (or an alias) under this id; see
 * src/routes/images.ts for the matching endpoint registry.
 */
export const DEFAULT_IMAGE_MODEL = "gpt-image-2"

export interface ImageGenerationConfig {
  model: string
  size?: string
  quality?: string
  output_format?: "png" | "jpeg"
  background?: "transparent" | "opaque" | "auto"
  moderation?: "auto" | "low"
  output_compression?: number
}

export interface ImageGenerationError {
  type: string
  code: string
  message: string
}

/**
 * Extract the hosted `image_generation` tool config from a Responses
 * payload. The LAST hosted entry wins (most-recent declaration), matching
 * the reference implementation's behavior. Returns `null` if no such
 * tool entry exists.
 */
export function extractImageGenerationConfig(
  tools: readonly ResponseTool[] | null | undefined,
): ImageGenerationConfig | null {
  if (!Array.isArray(tools)) return null
  let last: ImageGenerationConfig | null = null
  for (const tool of tools) {
    const t = tool as Record<string, unknown>
    if (t.type !== "image_generation") continue
    last = {
      model: typeof t.model === "string" && t.model.length > 0 ? t.model : DEFAULT_IMAGE_MODEL,
      ...(typeof t.size === "string" ? { size: t.size } : {}),
      ...(typeof t.quality === "string" ? { quality: t.quality } : {}),
      ...(t.output_format === "png" || t.output_format === "jpeg"
        ? { output_format: t.output_format }
        : {}),
      ...(t.background === "transparent" || t.background === "opaque" || t.background === "auto"
        ? { background: t.background }
        : {}),
      ...(t.moderation === "auto" || t.moderation === "low"
        ? { moderation: t.moderation }
        : {}),
      ...(typeof t.output_compression === "number"
        ? { output_compression: t.output_compression }
        : {}),
    }
  }
  return last
}

/**
 * Pull the prompt text out of a Responses request input. The orchestrator
 * isn't running in this slice, so the user's last input_text block (or
 * a bare string input) is taken verbatim as the image prompt.
 */
export function extractPromptFromInput(
  input: ResponsesPayload["input"],
): string {
  if (typeof input === "string") return input
  if (!Array.isArray(input)) return ""
  // Walk messages in reverse and take the last user message's text.
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as ResponseInputItem
    if (item.type !== "message") continue
    const msg = item
    if (msg.role !== "user") continue
    if (typeof msg.content === "string") return msg.content
    if (!Array.isArray(msg.content)) continue
    const parts: string[] = []
    for (const block of msg.content) {
      const b = block as { type?: string; text?: string }
      if ((b.type === "input_text" || b.type === "text") && typeof b.text === "string") {
        parts.push(b.text)
      }
    }
    if (parts.length > 0) return parts.join("\n")
  }
  return ""
}

export function synthesizeImageGenerationCallId(): string {
  return `ig_gw_${crypto.randomUUID().replace(/-/g, "")}`
}

export function synthesizeResponseId(): string {
  return `resp_gw_${crypto.randomUUID().replace(/-/g, "")}`
}

/**
 * Build the request body for the upstream `/images/generations` call.
 * `n:1` and bare base64 (no `response_format`) match the standalone-images
 * surface Azure expects.
 */
export function buildGenerationsBody(
  prompt: string,
  config: ImageGenerationConfig,
): Record<string, unknown> {
  return {
    model: config.model,
    prompt,
    n: 1,
    ...(config.size !== undefined ? { size: config.size } : {}),
    ...(config.quality !== undefined ? { quality: config.quality } : {}),
    ...(config.output_format !== undefined ? { output_format: config.output_format } : {}),
    ...(config.background !== undefined ? { background: config.background } : {}),
    ...(config.moderation !== undefined ? { moderation: config.moderation } : {}),
    ...(config.output_compression !== undefined ? { output_compression: config.output_compression } : {}),
  }
}

export interface ImageGenerationOutcome {
  ok: boolean
  b64?: string
  error?: ImageGenerationError
  echo: { output_format?: "png" | "jpeg"; quality?: string; background?: string; size?: string }
  upstreamMs: number
}

const errorFromBody = (text: string, status: number): ImageGenerationError => {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown; code?: unknown; type?: unknown } }
    const err = parsed.error
    if (err) {
      return {
        type: typeof err.type === "string" ? err.type : "image_generation_error",
        code: typeof err.code === "string" ? err.code : `upstream_${status}`,
        message: typeof err.message === "string" ? err.message : `Image backend returned HTTP ${status}`,
      }
    }
  } catch {
    // fall through
  }
  return { type: "image_generation_error", code: `upstream_${status}`, message: `Image backend returned HTTP ${status}` }
}

const extractEcho = (parsed: unknown): ImageGenerationOutcome["echo"] => {
  if (!parsed || typeof parsed !== "object") return {}
  const s = parsed as Record<string, unknown>
  const echo: ImageGenerationOutcome["echo"] = {}
  if (s.output_format === "png" || s.output_format === "jpeg") echo.output_format = s.output_format
  if (typeof s.quality === "string") echo.quality = s.quality
  if (typeof s.background === "string") echo.background = s.background
  if (typeof s.size === "string") echo.size = s.size
  return echo
}

/**
 * Dispatch the prompt to the resolved images_generations binding and
 * normalize the result into a backend-agnostic outcome.
 */
export async function generateImageViaBinding(
  binding: ProviderBinding,
  prompt: string,
  config: ImageGenerationConfig,
): Promise<ImageGenerationOutcome> {
  const startedAt = Date.now()
  let response: Response
  try {
    response = await binding.provider.fetch(
      "images_generations" as EndpointKey,
      { method: "POST", body: JSON.stringify(buildGenerationsBody(prompt, config)) },
      { operationName: "image_generation shim", enabledFlags: binding.enabledFlags },
    )
  } catch (e) {
    return {
      ok: false,
      error: { type: "image_generation_error", code: "server_error", message: e instanceof Error ? e.message : String(e) },
      echo: {},
      upstreamMs: Date.now() - startedAt,
    }
  }
  const text = await response.text()
  const upstreamMs = Date.now() - startedAt
  if (!response.ok) {
    return { ok: false, error: errorFromBody(text, response.status), echo: {}, upstreamMs }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ok: false,
      error: { type: "image_generation_error", code: "server_error", message: "Image backend returned a non-JSON success body." },
      echo: {},
      upstreamMs,
    }
  }
  const data = (parsed as { data?: Array<{ b64_json?: unknown }> }).data
  const b64 = Array.isArray(data) && typeof data[0]?.b64_json === "string" ? data[0].b64_json : null
  if (!b64) {
    return {
      ok: false,
      error: { type: "image_generation_error", code: "server_error", message: "Image backend response did not contain image bytes." },
      echo: extractEcho(parsed),
      upstreamMs,
    }
  }
  return { ok: true, b64, echo: extractEcho(parsed), upstreamMs }
}

export interface ImageGenerationResponseShape {
  id: string
  object: "response"
  created_at: number
  model: string
  status: "completed" | "failed"
  output: Array<Record<string, unknown>>
  output_text: ""
  error: null
  incomplete_details: null
  instructions: null
  metadata: null
  parallel_tool_calls: false
  temperature: null
  tool_choice: "auto"
  tools: []
  top_p: null
  usage: { input_tokens: 0; output_tokens: 0; total_tokens: 0 }
}

/**
 * Build the Responses-shaped envelope returned to the caller. The single
 * output item is the `image_generation_call` item carrying the b64 result
 * (or a failed item with the upstream error).
 */
export function buildImageGenerationResponse(
  publicModel: string,
  prompt: string,
  outcome: ImageGenerationOutcome,
): ImageGenerationResponseShape {
  const itemId = synthesizeImageGenerationCallId()
  const item: Record<string, unknown> = outcome.ok
    ? {
        type: "image_generation_call",
        id: itemId,
        status: "completed",
        action: "generate",
        result: outcome.b64,
        revised_prompt: prompt,
        ...outcome.echo,
      }
    : {
        type: "image_generation_call",
        id: itemId,
        status: "failed",
        revised_prompt: prompt,
        error: outcome.error,
      }
  return {
    id: synthesizeResponseId(),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: publicModel,
    status: outcome.ok ? "completed" : "failed",
    output: [item],
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  }
}

/**
 * Synthesize the Responses-API SSE event sequence for a completed
 * image_generation_call response. Matches Azure's native lifecycle:
 *   response.created → response.in_progress
 *   response.output_item.added (status=in_progress)
 *   response.image_generation_call.in_progress
 *   response.image_generation_call.generating
 *   response.image_generation_call.completed   (only on success)
 *   response.output_item.done (final item)
 *   response.completed
 */
export function synthImageGenerationSSE(
  response: ImageGenerationResponseShape,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let seq = 0
      const emit = (type: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      const inProgressView = { ...response, status: "in_progress" as const, output: [] as typeof response.output }
      emit("response.created", { type: "response.created", response: inProgressView, sequence_number: seq++ })
      emit("response.in_progress", { type: "response.in_progress", response: inProgressView, sequence_number: seq++ })

      const item = response.output[0]
      if (!item) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
        return
      }
      const outputIndex = 0
      const itemId = item.id as string
      const inProgressItem = { type: "image_generation_call", id: itemId, status: "in_progress" }
      emit("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: inProgressItem,
        sequence_number: seq++,
      })
      emit("response.image_generation_call.in_progress", {
        type: "response.image_generation_call.in_progress",
        output_index: outputIndex,
        item_id: itemId,
        sequence_number: seq++,
      })
      emit("response.image_generation_call.generating", {
        type: "response.image_generation_call.generating",
        output_index: outputIndex,
        item_id: itemId,
        sequence_number: seq++,
      })
      if (item.status === "completed") {
        emit("response.image_generation_call.completed", {
          type: "response.image_generation_call.completed",
          output_index: outputIndex,
          item_id: itemId,
          sequence_number: seq++,
        })
      }
      emit("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
        sequence_number: seq++,
      })
      emit("response.completed", {
        type: "response.completed",
        response,
        sequence_number: seq++,
      })
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
}
