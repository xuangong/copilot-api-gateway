/**
 * Responses `image_generation` server-tool shim (single-turn slice + edits).
 *
 * Slice 2 scope: when a Responses request declares the hosted
 * `image_generation` tool, short-circuit the orchestrator entirely and
 * dispatch the user's prompt straight to the configured images backend.
 * Returns a Responses-shaped envelope whose single output item is an
 * `image_generation_call` carrying the resulting b64.
 *
 * Slice 3: when the input carries `input_image` blocks (or a previous
 * `image_generation_call` result), dispatch to `/images/edits` as
 * multipart/form-data instead of `/images/generations` — gpt-image-2 picks
 * the edit target by prompt semantics across all attached images.
 *
 * ReAct multi-turn (model decides when to call) and Azure-strict tool-config
 * validation arrive in slice 4 — keeping each slice small so it ships as
 * one commit.
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

// Azure-strict public surface for the `image_generation` tool entry.
// Azure rejects fields outside this list with `unknown_parameter` and
// enum values outside the allowed sets with `invalid_value`. The shim
// mirrors that strictness so misuse fails the same way against either
// backend rather than silently differing.
const ALLOWED_SIZES = new Set(["1024x1024", "1024x1536", "1536x1024", "auto"])
const ALLOWED_QUALITIES = new Set(["low", "medium", "high", "auto"])
const ALLOWED_BACKGROUNDS = new Set(["transparent", "opaque", "auto"])
const ALLOWED_OUTPUT_FORMATS = new Set(["png", "jpeg"])
const ALLOWED_MODERATIONS = new Set(["auto", "low"])
const KNOWN_TOOL_FIELDS = new Set([
  "type", "model", "size", "quality", "background", "output_format",
  "output_compression", "moderation",
])

export interface ImageGenerationConfigError {
  message: string
  param: string
  code: "unknown_parameter" | "invalid_value" | "integer_below_min_value" | "integer_above_max_value"
}

export type ImageGenerationConfigResult =
  | { ok: true; config: ImageGenerationConfig }
  | { ok: false; error: ImageGenerationConfigError }

const invalidValue = (param: string, value: unknown, allowed: Iterable<string>): ImageGenerationConfigError => ({
  message: `Invalid value: ${JSON.stringify(value)}. Supported values are: ${[...allowed].map((v) => `'${v}'`).join(", ")}.`,
  param,
  code: "invalid_value",
})

const integerInRange = (
  value: unknown,
  param: string,
  min: number,
  max: number,
): ImageGenerationConfigError | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { message: `Invalid value: ${JSON.stringify(value)}. Expected an integer in [${min}, ${max}].`, param, code: "invalid_value" }
  }
  if (value < min) return { message: `Invalid value: ${value}. Expected an integer >= ${min}.`, param, code: "integer_below_min_value" }
  if (value > max) return { message: `Invalid value: ${value}. Expected an integer <= ${max}.`, param, code: "integer_above_max_value" }
  return null
}

/**
 * Strict per-entry validation of every `image_generation` tool entry,
 * mirroring Azure's `tools[i].field` error paths. The LAST valid entry's
 * config wins (most-recent-declaration), but any earlier entry's bad
 * field still rejects the whole request — that matches Azure's per-entry
 * strictness and avoids silently masking client bugs.
 */
export function validateImageGenerationConfig(
  tools: readonly ResponseTool[] | null | undefined,
): ImageGenerationConfigResult {
  if (!Array.isArray(tools)) {
    return { ok: false, error: { message: "No image_generation tool present.", param: "tools", code: "unknown_parameter" } }
  }
  let config: ImageGenerationConfig | undefined
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i] as Record<string, unknown>
    if (tool.type !== "image_generation") continue
    const path = (field: string): string => `tools[${i}].${field}`
    for (const key of Object.keys(tool)) {
      if (!KNOWN_TOOL_FIELDS.has(key) && tool[key] !== undefined) {
        return { ok: false, error: { message: `Unknown parameter: '${path(key)}'.`, param: path(key), code: "unknown_parameter" } }
      }
    }
    const modelRaw = tool.model
    if (modelRaw !== undefined && modelRaw !== null && (typeof modelRaw !== "string" || modelRaw.length === 0)) {
      return { ok: false, error: { message: `Invalid value: ${JSON.stringify(modelRaw)}. Expected a non-empty model id.`, param: path("model"), code: "invalid_value" } }
    }
    const size = tool.size
    if (size !== undefined && size !== null && (typeof size !== "string" || !ALLOWED_SIZES.has(size))) {
      return { ok: false, error: invalidValue(path("size"), size, ALLOWED_SIZES) }
    }
    const quality = tool.quality
    if (quality !== undefined && quality !== null && (typeof quality !== "string" || !ALLOWED_QUALITIES.has(quality))) {
      return { ok: false, error: invalidValue(path("quality"), quality, ALLOWED_QUALITIES) }
    }
    const background = tool.background
    if (background !== undefined && background !== null && (typeof background !== "string" || !ALLOWED_BACKGROUNDS.has(background))) {
      return { ok: false, error: invalidValue(path("background"), background, ALLOWED_BACKGROUNDS) }
    }
    const outputFormat = tool.output_format
    if (outputFormat !== undefined && outputFormat !== null && (typeof outputFormat !== "string" || !ALLOWED_OUTPUT_FORMATS.has(outputFormat))) {
      return { ok: false, error: invalidValue(path("output_format"), outputFormat, ALLOWED_OUTPUT_FORMATS) }
    }
    const moderation = tool.moderation
    if (moderation !== undefined && moderation !== null && (typeof moderation !== "string" || !ALLOWED_MODERATIONS.has(moderation))) {
      return { ok: false, error: invalidValue(path("moderation"), moderation, ALLOWED_MODERATIONS) }
    }
    const compressionError = integerInRange(tool.output_compression, path("output_compression"), 0, 100)
    if (compressionError !== null) return { ok: false, error: compressionError }
    config = {
      model: typeof modelRaw === "string" && modelRaw.length > 0 ? modelRaw : DEFAULT_IMAGE_MODEL,
      ...(typeof size === "string" ? { size } : {}),
      ...(typeof quality === "string" ? { quality } : {}),
      ...(typeof outputFormat === "string" ? { output_format: outputFormat as "png" | "jpeg" } : {}),
      ...(typeof background === "string" ? { background: background as ImageGenerationConfig["background"] } : {}),
      ...(typeof moderation === "string" ? { moderation: moderation as "auto" | "low" } : {}),
      ...(typeof tool.output_compression === "number" ? { output_compression: tool.output_compression } : {}),
    }
  }
  if (config === undefined) {
    return { ok: false, error: { message: "No image_generation tool present.", param: "tools", code: "unknown_parameter" } }
  }
  return { ok: true, config }
}

export function synthesizeImageGenerationCallId(): string {
  return `ig_gw_${crypto.randomUUID().replace(/-/g, "")}`
}

export function synthesizeResponseId(): string {
  return `resp_gw_${crypto.randomUUID().replace(/-/g, "")}`
}

/**
 * gpt-image-* `/images/edits` only accepts these source mimetypes; Azure
 * gates on multipart content-type before decoding, so we forward the
 * canonical form. Common aliases are folded onto the canonical form.
 */
const EDIT_MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
}
const EDIT_SUPPORTED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"])

export function editSupportedMime(mime: string): string | null {
  const canonical = EDIT_MIME_ALIASES[mime] ?? mime
  return EDIT_SUPPORTED_MIMES.has(canonical) ? canonical : null
}

function editFileExt(mime: string): string {
  if (mime === "image/jpeg") return "jpg"
  if (mime === "image/webp") return "webp"
  return "png"
}

export interface ImageSource {
  bytes: ArrayBuffer
  mimeType: string
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const buffer = new ArrayBuffer(binary.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i)
  return buffer
}

/**
 * Parse a `data:<mime>;base64,<payload>` URL or a bare base64 string.
 * Remote URLs (http(s)) are NOT fetched — only inline bytes are bound.
 */
export function decodeInlineImage(
  imageUrl: string,
  fallbackMime = "image/png",
): ImageSource | null {
  const dataUrlMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl)
  if (!dataUrlMatch) {
    if (/^https?:\/\//i.test(imageUrl)) return null
    try {
      return { bytes: base64ToArrayBuffer(imageUrl), mimeType: fallbackMime }
    } catch {
      return null
    }
  }
  const isBase64 = dataUrlMatch[2] !== undefined
  if (!isBase64) return null
  try {
    return {
      bytes: base64ToArrayBuffer(dataUrlMatch[3] ?? ""),
      mimeType: dataUrlMatch[1] ?? fallbackMime,
    }
  } catch {
    return null
  }
}

/**
 * Walk a Responses input and collect every inline image source in forward
 * declaration order. Order is load-bearing: gpt-image numbers attached
 * images positionally, so a prompt like "edit the second image" resolves
 * the same way native does.
 */
export function collectImageSources(input: ResponsesPayload["input"]): ImageSource[] {
  if (!Array.isArray(input)) return []
  const sources: ImageSource[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const it = item as ResponseInputItem & { content?: unknown; result?: unknown; output_format?: unknown }
    if (it.type === "message" && Array.isArray(it.content)) {
      for (const block of it.content) {
        const b = block as { type?: string; image_url?: unknown }
        if (b.type === "input_image" && typeof b.image_url === "string") {
          const decoded = decodeInlineImage(b.image_url)
          if (decoded) sources.push(decoded)
        }
      }
    }
  }
  return sources
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
 * Build a multipart/form-data body for the upstream `/images/edits` call.
 * Sources attach as `image[]` repeated parts — gpt-image-2 picks the edit
 * target by prompt semantics across all attached images, so order is not
 * load-bearing for the backend but we preserve declaration order for
 * deterministic prompts ("edit the second image" still resolves the same).
 * Sources with unsupported mimetypes are skipped by the caller; if any
 * slips through we forward the raw mime so the backend fails loudly.
 */
export function buildEditsForm(
  prompt: string,
  config: ImageGenerationConfig,
  sources: readonly ImageSource[],
): FormData {
  const form = new FormData()
  form.append("model", config.model)
  form.append("prompt", prompt)
  form.append("n", "1")
  if (config.size !== undefined) form.append("size", config.size)
  if (config.quality !== undefined) form.append("quality", config.quality)
  if (config.output_format !== undefined) form.append("output_format", config.output_format)
  if (config.background !== undefined) form.append("background", config.background)
  if (config.moderation !== undefined) form.append("moderation", config.moderation)
  if (config.output_compression !== undefined) form.append("output_compression", String(config.output_compression))
  for (const [i, source] of sources.entries()) {
    const mime = editSupportedMime(source.mimeType) ?? source.mimeType
    form.append("image[]", new Blob([source.bytes], { type: mime }), `image_${i}.${editFileExt(mime)}`)
  }
  return form
}

/**
 * Dispatch the prompt to the resolved images binding and normalize the
 * result into a backend-agnostic outcome. When `sources` is non-empty,
 * dispatches to `images_edits` with multipart/form-data; otherwise hits
 * `images_generations` with a JSON body.
 */
export async function generateImageViaBinding(
  binding: ProviderBinding,
  prompt: string,
  config: ImageGenerationConfig,
  sources: readonly ImageSource[] = [],
): Promise<ImageGenerationOutcome> {
  const startedAt = Date.now()
  const isEdit = sources.length > 0
  const endpoint: EndpointKey = (isEdit ? "images_edits" : "images_generations") as EndpointKey
  const init: { method: string; body: BodyInit } = isEdit
    ? { method: "POST", body: buildEditsForm(prompt, config, sources) }
    : { method: "POST", body: JSON.stringify(buildGenerationsBody(prompt, config)) }
  let response: Response
  try {
    response = await binding.provider.fetch(
      endpoint,
      init,
      { operationName: isEdit ? "image_generation edits shim" : "image_generation shim", enabledFlags: binding.enabledFlags },
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
