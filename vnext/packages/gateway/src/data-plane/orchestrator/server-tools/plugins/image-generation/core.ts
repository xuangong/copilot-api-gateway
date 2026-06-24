/**
 * image_generation server-tool — core helpers (Week 4b-4 port).
 *
 * Ported from src/services/image-generation/index.ts. Behavior preserved:
 *   - LAST hosted entry wins (most-recent declaration)
 *   - Azure-strict per-entry validation (unknown_parameter / invalid_value)
 *   - bare base64 (no response_format) and n:1 for generations body
 *   - multipart `image[]` repeats for edits, preserving declaration order
 *   - data: URL only, http(s) NOT fetched
 *
 * vnext deltas:
 *   - ResponseTool / ResponseInputItem typed as ServerToolPlugin's open shape
 *     instead of the old `~/transforms` re-exports; functionality unchanged.
 *   - ProviderBinding sourced from data-plane/routing/binding.ts (not old
 *     ~/providers/binding) — provider.fetch signature is identical.
 */
import type { EndpointKey } from '@vnext-llm/protocols/common'
import type { ProviderBinding } from '../../../../routing/binding.ts'
import { runImagesAttempt } from '../../../../observability/attempts/images-attempt.ts'
import type { ResponsesTool, ResponsesInputItem } from '../../types.ts'

export const SHIM_TOOL_NAME = 'image_generation'
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2'

export interface ImageGenerationConfig {
  model: string
  size?: string
  quality?: string
  output_format?: 'png' | 'jpeg'
  background?: 'transparent' | 'opaque' | 'auto'
  moderation?: 'auto' | 'low'
  output_compression?: number
}

export interface ImageGenerationError {
  type: string
  code: string
  message: string
}

const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto'])
const ALLOWED_QUALITIES = new Set(['low', 'medium', 'high', 'auto'])
const ALLOWED_BACKGROUNDS = new Set(['transparent', 'opaque', 'auto'])
const ALLOWED_OUTPUT_FORMATS = new Set(['png', 'jpeg'])
const ALLOWED_MODERATIONS = new Set(['auto', 'low'])
const KNOWN_TOOL_FIELDS = new Set([
  'type', 'model', 'size', 'quality', 'background', 'output_format',
  'output_compression', 'moderation',
])

export interface ImageGenerationConfigError {
  message: string
  param: string
  code: 'unknown_parameter' | 'invalid_value' | 'integer_below_min_value' | 'integer_above_max_value'
}

export type ImageGenerationConfigResult =
  | { ok: true; config: ImageGenerationConfig }
  | { ok: false; error: ImageGenerationConfigError }

const invalidValue = (param: string, value: unknown, allowed: Iterable<string>): ImageGenerationConfigError => ({
  message: `Invalid value: ${JSON.stringify(value)}. Supported values are: ${[...allowed].map((v) => `'${v}'`).join(', ')}.`,
  param,
  code: 'invalid_value',
})

const integerInRange = (
  value: unknown,
  param: string,
  min: number,
  max: number,
): ImageGenerationConfigError | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { message: `Invalid value: ${JSON.stringify(value)}. Expected an integer in [${min}, ${max}].`, param, code: 'invalid_value' }
  }
  if (value < min) return { message: `Invalid value: ${value}. Expected an integer >= ${min}.`, param, code: 'integer_below_min_value' }
  if (value > max) return { message: `Invalid value: ${value}. Expected an integer <= ${max}.`, param, code: 'integer_above_max_value' }
  return null
}

export function validateImageGenerationConfig(
  tools: readonly ResponsesTool[] | null | undefined,
): ImageGenerationConfigResult {
  if (!Array.isArray(tools)) {
    return { ok: false, error: { message: 'No image_generation tool present.', param: 'tools', code: 'unknown_parameter' } }
  }
  let config: ImageGenerationConfig | undefined
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i] as Record<string, unknown>
    if (tool.type !== 'image_generation') continue
    const path = (field: string): string => `tools[${i}].${field}`
    for (const key of Object.keys(tool)) {
      if (!KNOWN_TOOL_FIELDS.has(key) && tool[key] !== undefined) {
        return { ok: false, error: { message: `Unknown parameter: '${path(key)}'.`, param: path(key), code: 'unknown_parameter' } }
      }
    }
    const modelRaw = tool.model
    if (modelRaw !== undefined && modelRaw !== null && (typeof modelRaw !== 'string' || modelRaw.length === 0)) {
      return { ok: false, error: { message: `Invalid value: ${JSON.stringify(modelRaw)}. Expected a non-empty model id.`, param: path('model'), code: 'invalid_value' } }
    }
    const size = tool.size
    if (size !== undefined && size !== null && (typeof size !== 'string' || !ALLOWED_SIZES.has(size))) {
      return { ok: false, error: invalidValue(path('size'), size, ALLOWED_SIZES) }
    }
    const quality = tool.quality
    if (quality !== undefined && quality !== null && (typeof quality !== 'string' || !ALLOWED_QUALITIES.has(quality))) {
      return { ok: false, error: invalidValue(path('quality'), quality, ALLOWED_QUALITIES) }
    }
    const background = tool.background
    if (background !== undefined && background !== null && (typeof background !== 'string' || !ALLOWED_BACKGROUNDS.has(background))) {
      return { ok: false, error: invalidValue(path('background'), background, ALLOWED_BACKGROUNDS) }
    }
    const outputFormat = tool.output_format
    if (outputFormat !== undefined && outputFormat !== null && (typeof outputFormat !== 'string' || !ALLOWED_OUTPUT_FORMATS.has(outputFormat))) {
      return { ok: false, error: invalidValue(path('output_format'), outputFormat, ALLOWED_OUTPUT_FORMATS) }
    }
    const moderation = tool.moderation
    if (moderation !== undefined && moderation !== null && (typeof moderation !== 'string' || !ALLOWED_MODERATIONS.has(moderation))) {
      return { ok: false, error: invalidValue(path('moderation'), moderation, ALLOWED_MODERATIONS) }
    }
    const compressionError = integerInRange(tool.output_compression, path('output_compression'), 0, 100)
    if (compressionError !== null) return { ok: false, error: compressionError }
    config = {
      model: typeof modelRaw === 'string' && modelRaw.length > 0 ? modelRaw : DEFAULT_IMAGE_MODEL,
      ...(typeof size === 'string' ? { size } : {}),
      ...(typeof quality === 'string' ? { quality } : {}),
      ...(typeof outputFormat === 'string' ? { output_format: outputFormat as 'png' | 'jpeg' } : {}),
      ...(typeof background === 'string' ? { background: background as ImageGenerationConfig['background'] } : {}),
      ...(typeof moderation === 'string' ? { moderation: moderation as 'auto' | 'low' } : {}),
      ...(typeof tool.output_compression === 'number' ? { output_compression: tool.output_compression } : {}),
    }
  }
  if (config === undefined) {
    return { ok: false, error: { message: 'No image_generation tool present.', param: 'tools', code: 'unknown_parameter' } }
  }
  return { ok: true, config }
}

export function hasImageGeneration(tools: readonly ResponsesTool[] | null | undefined): boolean {
  if (!Array.isArray(tools)) return false
  return tools.some((t) => (t as { type?: string }).type === 'image_generation')
}

export function extractPromptFromInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (!Array.isArray(input)) return ''
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as ResponsesInputItem
    if (item.type !== 'message') continue
    const msg = item as { role?: string; content?: unknown }
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    if (!Array.isArray(msg.content)) continue
    const parts: string[] = []
    for (const block of msg.content) {
      const b = block as { type?: string; text?: string }
      if ((b.type === 'input_text' || b.type === 'text') && typeof b.text === 'string') {
        parts.push(b.text)
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}

export function synthesizeImageGenerationCallId(): string {
  return `ig_gw_${crypto.randomUUID().replace(/-/g, '')}`
}

export function synthesizeResponseId(): string {
  return `resp_gw_${crypto.randomUUID().replace(/-/g, '')}`
}

const EDIT_MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
}
const EDIT_SUPPORTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

export function editSupportedMime(mime: string): string | null {
  const canonical = EDIT_MIME_ALIASES[mime] ?? mime
  return EDIT_SUPPORTED_MIMES.has(canonical) ? canonical : null
}

function editFileExt(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  return 'png'
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

export function decodeInlineImage(
  imageUrl: string,
  fallbackMime = 'image/png',
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
      bytes: base64ToArrayBuffer(dataUrlMatch[3] ?? ''),
      mimeType: dataUrlMatch[1] ?? fallbackMime,
    }
  } catch {
    return null
  }
}

export function collectImageSources(input: unknown): ImageSource[] {
  if (!Array.isArray(input)) return []
  const sources: ImageSource[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const it = item as { type?: string; content?: unknown }
    if (it.type === 'message' && Array.isArray(it.content)) {
      for (const block of it.content) {
        const b = block as { type?: string; image_url?: unknown }
        if (b.type === 'input_image' && typeof b.image_url === 'string') {
          const decoded = decodeInlineImage(b.image_url)
          if (decoded) sources.push(decoded)
        }
      }
    }
  }
  return sources
}

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
  echo: { output_format?: 'png' | 'jpeg'; quality?: string; background?: string; size?: string }
  upstreamMs: number
}

const errorFromBody = (text: string, status: number): ImageGenerationError => {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown; code?: unknown; type?: unknown } }
    const err = parsed.error
    if (err) {
      return {
        type: typeof err.type === 'string' ? err.type : 'image_generation_error',
        code: typeof err.code === 'string' ? err.code : `upstream_${status}`,
        message: typeof err.message === 'string' ? err.message : `Image backend returned HTTP ${status}`,
      }
    }
  } catch { /* fall through */ }
  return { type: 'image_generation_error', code: `upstream_${status}`, message: `Image backend returned HTTP ${status}` }
}

const extractEcho = (parsed: unknown): ImageGenerationOutcome['echo'] => {
  if (!parsed || typeof parsed !== 'object') return {}
  const s = parsed as Record<string, unknown>
  const echo: ImageGenerationOutcome['echo'] = {}
  if (s.output_format === 'png' || s.output_format === 'jpeg') echo.output_format = s.output_format
  if (typeof s.quality === 'string') echo.quality = s.quality
  if (typeof s.background === 'string') echo.background = s.background
  if (typeof s.size === 'string') echo.size = s.size
  return echo
}

export function buildEditsForm(
  prompt: string,
  config: ImageGenerationConfig,
  sources: readonly ImageSource[],
): FormData {
  const form = new FormData()
  form.append('model', config.model)
  form.append('prompt', prompt)
  form.append('n', '1')
  if (config.size !== undefined) form.append('size', config.size)
  if (config.quality !== undefined) form.append('quality', config.quality)
  if (config.output_format !== undefined) form.append('output_format', config.output_format)
  if (config.background !== undefined) form.append('background', config.background)
  if (config.moderation !== undefined) form.append('moderation', config.moderation)
  if (config.output_compression !== undefined) form.append('output_compression', String(config.output_compression))
  for (const [i, source] of sources.entries()) {
    const mime = editSupportedMime(source.mimeType) ?? source.mimeType
    form.append('image[]', new Blob([source.bytes], { type: mime }), `image_${i}.${editFileExt(mime)}`)
  }
  return form
}

export interface ImageGenerationObservability {
  apiKeyId?: string
  userAgent?: string
  requestId?: string
}

export async function generateImageViaBinding(
  binding: ProviderBinding,
  prompt: string,
  config: ImageGenerationConfig,
  sources: readonly ImageSource[] = [],
  obs?: ImageGenerationObservability,
): Promise<ImageGenerationOutcome> {
  const startedAt = Date.now()
  const isEdit = sources.length > 0
  const endpoint: EndpointKey = (isEdit ? 'images_edits' : 'images_generations') as EndpointKey
  const payload: unknown = isEdit
    ? buildEditsForm(prompt, config, sources)
    : buildGenerationsBody(prompt, config)
  const upstreamCall = async () => {
    const pr = await binding.provider.fetch({
      endpoint,
      payload,
      headers: new Headers(isEdit ? {} : { 'content-type': 'application/json' }),
      sourceApi: 'openai',
      operationName: isEdit ? 'image_generation edits shim' : 'image_generation shim',
      flags: { isStreaming: false },
    })
    return new Response(pr.body, { status: pr.status, headers: pr.headers })
  }

  let response: Response
  try {
    // The attempt module wraps quota/latency around the leaf upstream call;
    // a missing apiKeyId is a silent no-op so this branch is the single hot path.
    const attempt = await runImagesAttempt({
      apiKeyId: obs?.apiKeyId,
      model: config.model,
      upstream: 'github_copilot',
      userAgent: obs?.userAgent,
      requestId: obs?.requestId,
      call: upstreamCall,
    })
    if (!attempt.ok) {
      if ('rateLimit' in attempt) {
        return {
          ok: false,
          error: { type: 'image_generation_error', code: 'rate_limited', message: attempt.rateLimit.reason },
          echo: {},
          upstreamMs: Date.now() - startedAt,
        }
      }
      // Non-2xx → preserve the prior parse path on the response body.
      response = attempt.response
    } else {
      response = attempt.response
    }
  } catch (e) {
    return {
      ok: false,
      error: { type: 'image_generation_error', code: 'server_error', message: e instanceof Error ? e.message : String(e) },
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
      error: { type: 'image_generation_error', code: 'server_error', message: 'Image backend returned a non-JSON success body.' },
      echo: {},
      upstreamMs,
    }
  }
  const data = (parsed as { data?: Array<{ b64_json?: unknown }> }).data
  const b64 = Array.isArray(data) && typeof data[0]?.b64_json === 'string' ? data[0].b64_json : null
  if (!b64) {
    return {
      ok: false,
      error: { type: 'image_generation_error', code: 'server_error', message: 'Image backend response did not contain image bytes.' },
      echo: extractEcho(parsed),
      upstreamMs,
    }
  }
  return { ok: true, b64, echo: extractEcho(parsed), upstreamMs }
}

export interface ImageGenerationResponseShape {
  id: string
  object: 'response'
  created_at: number
  model: string
  status: 'completed' | 'failed'
  output: Array<Record<string, unknown>>
  output_text: ''
  error: null
  incomplete_details: null
  instructions: null
  metadata: null
  parallel_tool_calls: false
  temperature: null
  tool_choice: 'auto'
  tools: []
  top_p: null
  usage: { input_tokens: 0; output_tokens: 0; total_tokens: 0 }
}

export function buildImageGenerationResponse(
  publicModel: string,
  prompt: string,
  outcome: ImageGenerationOutcome,
): ImageGenerationResponseShape {
  const itemId = synthesizeImageGenerationCallId()
  const item: Record<string, unknown> = outcome.ok
    ? {
        type: 'image_generation_call',
        id: itemId,
        status: 'completed',
        action: 'generate',
        result: outcome.b64,
        revised_prompt: prompt,
        ...outcome.echo,
      }
    : {
        type: 'image_generation_call',
        id: itemId,
        status: 'failed',
        revised_prompt: prompt,
        error: outcome.error,
      }
  return {
    id: synthesizeResponseId(),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: publicModel,
    status: outcome.ok ? 'completed' : 'failed',
    output: [item],
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: 'auto',
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
 *   response.image_generation_call.completed (only on success)
 *   response.output_item.done
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
      const inProgressView = { ...response, status: 'in_progress' as const, output: [] as typeof response.output }
      emit('response.created', { type: 'response.created', response: inProgressView, sequence_number: seq++ })
      emit('response.in_progress', { type: 'response.in_progress', response: inProgressView, sequence_number: seq++ })

      const item = response.output[0]
      if (!item) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
        return
      }
      const outputIndex = 0
      const itemId = item.id as string
      const inProgressItem = { type: 'image_generation_call', id: itemId, status: 'in_progress' }
      emit('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: inProgressItem,
        sequence_number: seq++,
      })
      emit('response.image_generation_call.in_progress', {
        type: 'response.image_generation_call.in_progress',
        output_index: outputIndex,
        item_id: itemId,
        sequence_number: seq++,
      })
      emit('response.image_generation_call.generating', {
        type: 'response.image_generation_call.generating',
        output_index: outputIndex,
        item_id: itemId,
        sequence_number: seq++,
      })
      if (item.status === 'completed') {
        emit('response.image_generation_call.completed', {
          type: 'response.image_generation_call.completed',
          output_index: outputIndex,
          item_id: itemId,
          sequence_number: seq++,
        })
      }
      emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item,
        sequence_number: seq++,
      })
      emit('response.completed', {
        type: 'response.completed',
        response,
        sequence_number: seq++,
      })
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}
