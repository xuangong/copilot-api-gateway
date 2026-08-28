/**
 * Responses `image_generation` server-tool plugin (Spec 13-D).
 *
 * Ported 1:1 from copilot-gateway
 * `packages/gateway/src/data-plane/chat/responses/interceptors/server-tools/image-generation.ts`.
 *
 * Adaptations from the reference:
 *   - `@floway-dev/*` → `@vibe-core/*` / `@vibe-llm/*`.
 *   - vNext `Provider.fetch({ endpoint, payload })` replaces the reference's
 *     per-provider `callImagesGenerations` / `callImagesEdits` methods.
 *     `serializeOpenAIImagesEditsRequest` from `@vibe-llm/provider-llm`
 *     produces the multipart / JSON body.
 *   - `enumerateBindingCandidates({ pickTarget: e => e.images_edits ?? null })`
 *     replaces reference `enumerateModelCandidates({ kind:'image', endpoints:'imagesEdits' })`.
 *   - `waitUntil(promise)` from `@vibe-core/platform` replaces
 *     `state.backgroundScheduler(promise)`.
 *   - `getRuntimeLocation()` from `@vibe-core/platform` replaces
 *     `state.runtimeLocation` / `gatewayCtx.runtimeLocation`.
 *   - `invocation.enabledFlags.has(...)` replaces
 *     `providerModelOf(invocation.candidate).enabledFlags.has(...)`.
 *   - `appendFailedUpstreams(msg, [])` — vNext registry does not track
 *     per-request failed upstreams, so the shim degrades to an empty array
 *     when composing "no candidate available" errors.
 *   - vNext protocols do not export narrowed `ResponsesHostedTool` /
 *     `ResponsesFunctionTool` / `ResponsesFunctionToolCallItem` /
 *     `ResponsesInputImageGenerationCall`, so we alias loose structural
 *     types on top of `ResponsesTool` / `ResponsesInputItem` (same pattern
 *     as the web-search plugin port).
 *   - `getImageProcessor().compressToWebp(bytes, target)` — vNext's `target`
 *     is a mandatory `ImageSizeCalculator` (function). Reference accepted
 *     `ImageDimensions | null` (null = keep original size). vNext keeps the
 *     original size via an identity calculator `d => d`.
 */
import type { ResponsesTool, ResponsesInputItem } from '../../../../orchestrator/server-tools/types.ts'
import type { ApiKeyId } from '../../../../../repo/branded-ids.ts'
import type { ResponsesInputImage } from '@vibe-llm/protocols/responses'
import { getImageProcessor, dimensionsFromBytes } from '@vibe-core/platform'
import { createRandomResponsesItemId } from '@vibe-llm/protocols/responses'
import { serverToolTrace } from './trace.ts'
import {
  createExternalImageFetcher,
  type ExternalImageFetchResult,
} from '../../../../../data-plane/shared/external-image-loader.ts'

// vNext protocols do not narrow the function-tool shape; alias a loose
// structural type over ResponsesTool (same pattern as web-search.ts).
type ResponsesFunctionTool = ResponsesTool & {
  type: 'function'
  name: string
  description?: string
  parameters?: unknown
  strict?: boolean
}

export const SHIM_TOOL_NAME = 'image_generation'

// Default image backend when the hosted tool omits `model`. gpt-image-2 is
// the reference backend Azure's native Responses `image_generation` routes
// to; operators provision it under this public id (or alias it).
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2'

// Safety valve on the multi-turn ReAct loop: cap how many real image backend
// calls one response may dispatch (counted on `ShimState.imageDispatchCount`,
// not the shared ReAct turn count, so unrelated turns do not consume the
// budget). Past the cap the dispatcher replays an exhausted-budget tool output
// instead of hitting the backend, so a model that keeps retrying after failures
// cannot drive unbounded image cost.
export const IMAGE_ITERATION_CAP = 10

// Public Responses `image_generation` tool config enums (Azure-strict
// surface). `webp` and arbitrary `WxH` sizes are rejected because the
// native Azure path rejects them; the shim mirrors that vocabulary rather
// than passing them to a backend that would 400 with a different shape.
export const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto'])
export const ALLOWED_QUALITIES = new Set(['low', 'medium', 'high', 'auto'])
export const ALLOWED_BACKGROUNDS = new Set(['transparent', 'opaque', 'auto'])
export const ALLOWED_OUTPUT_FORMATS = new Set(['png', 'jpeg'])
export const ALLOWED_MODERATIONS = new Set(['auto', 'low'])
export const ALLOWED_ACTIONS = new Set(['generate', 'edit', 'auto'])
export const ALLOWED_INPUT_FIDELITY = new Set(['high', 'low'])

// gpt-image-* `/images/edits` accepts only these input image mimetypes; a live
// Azure probe confirmed png/jpeg/webp succeed while gif is rejected with
// `unsupported_file_mimetype`. Native Responses accepts the same GIF and
// re-encodes it before editing, so the shim mirrors that behavior through the
// platform image processor. Common aliases are folded onto the backend form.
export type EditMime = 'image/png' | 'image/jpeg' | 'image/webp'

export const EDIT_MIME_ALIASES: Record<string, EditMime> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
}

// The canonical edit-supported mimetype for a source, or null when the
// standalone endpoint requires local WebP transcoding first.
export const editSupportedMime = (mime: string): EditMime | null => {
  const canonical = EDIT_MIME_ALIASES[mime] ?? mime
  return canonical === 'image/png' || canonical === 'image/jpeg' || canonical === 'image/webp'
    ? canonical
    : null
}

export const editFileExt = (mime: EditMime): string =>
  mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'

// The public `image_generation` tool-config surface. Azure rejects any other
// field with `unknown_parameter`, so the shim mirrors that strictness rather
// than silently forwarding unknown fields (which would diverge from the
// emulated surface and hide client bugs). `n` is deliberately absent: Azure
// echoes `n:1` internally but rejects a client-supplied `tools[].n`.
export const KNOWN_TOOL_FIELDS = new Set([
  'type', 'model', 'size', 'quality', 'background', 'output_format',
  'output_compression', 'moderation', 'partial_images', 'input_fidelity',
  'input_image_mask', 'action',
])

// vNext protocols do not narrow the hosted-image-generation tool shape;
// alias a loose structural type over ResponsesTool (same pattern as the
// web-search plugin port).
export type ResponsesHostedImageGenerationTool = ResponsesTool & { type: 'image_generation' }

export const isHostedImageGenerationTool = (tool: ResponsesTool): tool is ResponsesHostedImageGenerationTool =>
  tool.type === 'image_generation'

// Identity canonicalization for image_generation: the shim doesn't
// depend on filled defaults to run, and the OpenAI spec defaults for
// `background` / `quality` / `size` / etc. observed via Azure echo
// (all `'auto'`) signal "backend decides" rather than concrete values
// the model needs. Preserving the client's raw shape keeps the echo
// round-trip minimal — anything the client didn't send stays absent.
export const canonicalizeImageGenerationTool = (raw: ResponsesTool): ResponsesHostedImageGenerationTool | undefined =>
  isHostedImageGenerationTool(raw) ? raw : undefined

// ─────────────────────────────────────────────────────────────────────────
// 13-D-5-b: image source decoding
// ─────────────────────────────────────────────────────────────────────────

// A base64-data-URL or bare-base64 image source bound for an edit call.
// Bytes are held in a concrete ArrayBuffer so they can be wrapped in a Blob.
export interface ImageSource {
  bytes: ArrayBuffer
  mimeType: string
}

export interface PreparedImageSource extends ImageSource {
  mimeType: EditMime
}

// Config-validation error shape (fully consumed by 13-D-5-c). Declared here
// because `RemoteImageSource` embeds a deferred `PrepareConfigError` that
// surfaces when materialization completes but the resulting bytes are still
// unusable (see 13-D-5-d).
export interface PrepareConfigError {
  message: string
  param: string
  code:
    | 'unknown_parameter'
    | 'invalid_value'
    | 'integer_below_min_value'
    | 'integer_above_max_value'
    | 'unsupported_image_source'
}

export interface RemoteImageSource {
  wireUrl: string
  invalidUrlParam: string
  afterMaterializationError?: PrepareConfigError
}

export type ImageSourceReference = ImageSource | RemoteImageSource

export const isRemoteImageSource = (source: ImageSourceReference): source is RemoteImageSource =>
  'wireUrl' in source

export const prepareEditSources = async (sources: readonly ImageSource[]): Promise<readonly PreparedImageSource[]> => {
  const keyBySource = new Map<ImageSource, Promise<string>>()
  const preparedByContent = new Map<string, Promise<PreparedImageSource>>()
  return await Promise.all(sources.map(async source => {
    const mimeType = editSupportedMime(source.mimeType)
    if (mimeType !== null) return { bytes: source.bytes, mimeType }

    let keyPromise = keyBySource.get(source)
    if (keyPromise === undefined) {
      keyPromise = crypto.subtle.digest('SHA-256', source.bytes).then(buffer => {
        const digest = [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')
        return `${source.mimeType} ${digest}`
      })
      keyBySource.set(source, keyPromise)
    }
    const key = await keyPromise

    let prepared = preparedByContent.get(key)
    if (prepared === undefined) {
      // Native Responses accepts formats such as GIF through its multimodal
      // preprocessing, while the standalone edits endpoint accepts only
      // PNG/JPEG/WebP. Re-encode locally to preserve the hosted-tool behavior.
      // https://github.com/openai/openai-node/blob/ec2f57fd0d66e94782656b986d7b3eb03225369c/src/resources/images.ts#L560-L572
      prepared = getImageProcessor().compressToWebp(new Uint8Array(source.bytes), d => d).then(encoded => {
        const bytes = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
        return { bytes, mimeType: 'image/webp' } satisfies PreparedImageSource
      })
      preparedByContent.set(key, prepared)
    }
    return await prepared
  }))
}

export const base64ToArrayBuffer = (b64: string): ArrayBuffer => {
  const binary = atob(b64)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return buffer
}

// Parse a `data:<mime>;base64,<payload>` URL or a bare base64 string (as
// emitted in `image_generation_call.result`) into raw bytes. Remote URLs are
// materialized at request preparation and therefore stay outside this decoder.
export const decodeInlineImage = (
  imageUrl: string,
  fallbackMime = 'image/png',
  cache?: Map<string, ImageSource | null>,
): ImageSource | null => {
  const dataUrlMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl)
  let payload: string
  let mimeType: string
  if (dataUrlMatch === null) {
    if (/^https?:\/\//i.test(imageUrl)) return null
    payload = imageUrl
    mimeType = fallbackMime
  } else {
    if (dataUrlMatch[2] === undefined) return null
    payload = dataUrlMatch[3]!
    mimeType = dataUrlMatch[1] ?? fallbackMime
  }

  // A generated result is bare base64 on its first appearance and a data URL
  // after the server-tool replay transform. Keying by decoded wire identity
  // lets both representations reuse the same bytes on later ReAct turns.
  const cacheKey = `${mimeType} ${payload}`
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? null

  let decoded: ImageSource | null
  try {
    decoded = { bytes: base64ToArrayBuffer(payload), mimeType }
  } catch {
    decoded = null
  }
  cache?.set(cacheKey, decoded)
  return decoded
}

export type InputImageDecodeResult =
  | { ok: true; source: ImageSource }
  | {
      ok: false
      reason: 'invalid_format' | 'missing_base64_separator' | 'unsupported_mime' | 'invalid_base64'
      mimeType?: string
    }

// Responses input_image.image_url is stricter than an internal replayed
// image_generation_call.result: it must be a fully qualified URL or an image
// data URL. Bare base64 remains valid only for the internal replay path.
export const decodeInputImageDataUrl = (
  imageUrl: string,
  decodedSources: Map<string, ImageSource | null>,
): InputImageDecodeResult => {
  const dataUrlMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl)
  if (dataUrlMatch === null) return { ok: false, reason: 'invalid_format' }

  const mimeType = dataUrlMatch[1] ?? ''
  if (!mimeType.toLowerCase().startsWith('image/')) {
    return { ok: false, reason: 'unsupported_mime', mimeType }
  }
  if (dataUrlMatch[2] === undefined) return { ok: false, reason: 'missing_base64_separator' }

  const payload = dataUrlMatch[3]!
  const cacheKey = `${mimeType} ${payload}`
  if (decodedSources.has(cacheKey)) {
    const source = decodedSources.get(cacheKey)
    return source === null || source === undefined
      ? { ok: false, reason: 'invalid_base64' }
      : { ok: true, source }
  }

  try {
    const source = { bytes: base64ToArrayBuffer(payload), mimeType }
    decodedSources.set(cacheKey, source)
    return { ok: true, source }
  } catch {
    decodedSources.set(cacheKey, null)
    return { ok: false, reason: 'invalid_base64' }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 13-D-5-c: config validation
// ─────────────────────────────────────────────────────────────────────────

// The orchestrator-visible tool config the shim layers onto the backend
// call. Mirrors Azure: the orchestrator only chooses `prompt`; everything
// here is read from the client's hosted-tool entry and applied by the shim.
export interface ImageGenerationConfig {
  model: string
  size?: string
  quality?: string
  output_format?: 'png' | 'jpeg'
  background?: 'transparent' | 'opaque' | 'auto'
  moderation?: 'auto' | 'low'
  output_compression?: number
  // When > 0, the backend call is issued with `stream:true` and each
  // progressively-rendered preview the backend emits is relayed as a native
  // `image_generation_call.partial_image` frame. When 0/absent the backend
  // is called non-streaming and no preview frames are produced.
  partial_images?: number
  input_fidelity?: 'high' | 'low'
  // Inpainting mask materialized once at validation, forwarded to
  // /images/edits as the standalone `mask` part. `file_id` masks are not
  // supported (rejected at validation) — resolving them needs the Files API.
  mask?: ImageSourceReference
  action: 'generate' | 'edit' | 'auto'
}

export type MaterializedImageGenerationConfig = Omit<ImageGenerationConfig, 'mask'> & { mask?: ImageSource }

export const prepareEditRequest = async (
  sources: readonly ImageSource[],
  config: MaterializedImageGenerationConfig,
): Promise<{ sources: readonly PreparedImageSource[]; mask?: PreparedImageSource }> => {
  const originals = [...sources]
  if (config.mask !== undefined && !originals.includes(config.mask)) originals.push(config.mask)
  const prepared = await prepareEditSources(originals)
  const bySource = new Map<ImageSource, PreparedImageSource>()
  for (const [index, source] of originals.entries()) {
    const wireSource = prepared[index]
    if (wireSource === undefined) throw new Error('Missing prepared image edit source')
    bySource.set(source, wireSource)
  }
  const wireSources = sources.map(source => {
    const wireSource = bySource.get(source)
    if (wireSource === undefined) throw new Error('Missing prepared image edit source')
    return wireSource
  })
  if (config.mask === undefined) return { sources: wireSources }
  const mask = bySource.get(config.mask)
  if (mask === undefined) throw new Error('Missing prepared image edit mask')
  return { sources: wireSources, mask }
}

export type PrepareConfigResult =
  | { ok: true; config: ImageGenerationConfig }
  | { ok: false; error: PrepareConfigError }

const invalidValue = (param: string, value: unknown, allowed: Iterable<string>): PrepareConfigError => ({
  message: `Invalid value: ${JSON.stringify(value)}. Supported values are: ${[...allowed].map(v => `'${v}'`).join(', ')}.`,
  param,
  code: 'invalid_value',
})

// Integer range check that mirrors Azure's distinct out-of-range codes
// (`integer_below_min_value` / `integer_above_max_value`) rather than
// collapsing them into a generic `invalid_value`.
const integerInRange = (value: unknown, param: string, min: number, max: number): PrepareConfigError | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { message: `Invalid value: ${JSON.stringify(value)}. Expected an integer in [${min}, ${max}].`, param, code: 'invalid_value' }
  }
  if (value < min) return { message: `Invalid value: ${value}. Expected an integer >= ${min}.`, param, code: 'integer_below_min_value' }
  if (value > max) return { message: `Invalid value: ${value}. Expected an integer <= ${max}.`, param, code: 'integer_above_max_value' }
  return null
}

// Validate one hosted `image_generation` entry against the public Responses
// surface and project it into the shim's config. Every hosted entry is
// validated (not just the last) so an earlier entry's bad field is rejected
// rather than masked by a later valid one — matching Azure's per-entry
// strictness with concrete `tools[i].field` paths.
const validateHostedImageGenerationEntry = (
  tool: ResponsesHostedImageGenerationTool,
  index: number,
): { ok: true; config: ImageGenerationConfig } | { ok: false; error: PrepareConfigError } => {
  const path = (field: string): string => `tools[${index}].${field}`

  // Reject any field outside the public surface (Azure-strict). This
  // subsumes `n` (absent from KNOWN_TOOL_FIELDS) and any typo'd / unsupported
  // field. First unknown key wins so the envelope names one offender.
  for (const key of Object.keys(tool)) {
    if (!KNOWN_TOOL_FIELDS.has(key) && (tool as Record<string, unknown>)[key] !== undefined) {
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
  const action = tool.action
  if (action !== undefined && action !== null && (typeof action !== 'string' || !ALLOWED_ACTIONS.has(action))) {
    return { ok: false, error: invalidValue(path('action'), action, ALLOWED_ACTIONS) }
  }
  const inputFidelity = tool.input_fidelity
  if (inputFidelity !== undefined && inputFidelity !== null && (typeof inputFidelity !== 'string' || !ALLOWED_INPUT_FIDELITY.has(inputFidelity))) {
    return { ok: false, error: invalidValue(path('input_fidelity'), inputFidelity, ALLOWED_INPUT_FIDELITY) }
  }
  const compressionError = integerInRange(tool.output_compression, path('output_compression'), 0, 100)
  if (compressionError !== null) return { ok: false, error: compressionError }
  const partialError = integerInRange(tool.partial_images, path('partial_images'), 0, 3)
  if (partialError !== null) return { ok: false, error: partialError }

  // The published OpenAI and Azure schemas make `image_url` and `file_id`
  // independently optional and define no mutual-exclusivity error. The gateway
  // cannot resolve a file ID in its owning upstream's Files namespace, so we
  // validate a supplied image URL first and then report `file_id` as an
  // unsupported source instead of silently choosing a field or inventing a
  // native 400 envelope.
  const maskField = tool.input_image_mask
  let mask: ImageSourceReference | undefined
  if (maskField !== undefined && maskField !== null) {
    if (typeof maskField !== 'object' || Array.isArray(maskField)) {
      return { ok: false, error: invalidValue(path('input_image_mask'), maskField, ['{ image_url }']) }
    }
    const maskInput = maskField as { image_url?: unknown; file_id?: unknown }
    const fileIdError: PrepareConfigError | null = typeof maskInput.file_id === 'string' && maskInput.file_id.length > 0
      ? {
          message: 'Gateway cannot resolve input_image_mask.file_id; remove file_id and provide image_url alone.',
          param: path('input_image_mask.file_id'),
          code: 'unsupported_image_source',
        }
      : null
    const maskUrl = maskInput.image_url
    if (typeof maskUrl !== 'string' || maskUrl.length === 0) {
      if (fileIdError !== null) return { ok: false, error: fileIdError }
      return {
        ok: false,
        error: invalidValue(path('input_image_mask'), maskField, ['{ image_url }']),
      }
    }
    if (/^https?:\/\//i.test(maskUrl)) {
      mask = {
        wireUrl: maskUrl,
        invalidUrlParam: path('input_image_mask.image_url'),
        ...(fileIdError === null ? {} : { afterMaterializationError: fileIdError }),
      }
    } else {
      const decodedMask = decodeInlineImage(maskUrl)
      if (decodedMask === null) {
        return {
          ok: false,
          error: { message: 'image_generation input_image_mask.image_url must contain valid base64 image data.', param: path('input_image_mask.image_url'), code: 'invalid_value' },
        }
      }
      mask = decodedMask
      if (fileIdError !== null) return { ok: false, error: fileIdError }
    }
  }

  return {
    ok: true,
    config: {
      model: typeof modelRaw === 'string' && modelRaw.length > 0 ? modelRaw : DEFAULT_IMAGE_MODEL,
      ...(typeof size === 'string' ? { size } : {}),
      ...(typeof quality === 'string' ? { quality } : {}),
      ...(typeof outputFormat === 'string' ? { output_format: outputFormat as 'png' | 'jpeg' } : {}),
      ...(typeof background === 'string' ? { background: background as 'transparent' | 'opaque' | 'auto' } : {}),
      ...(typeof moderation === 'string' ? { moderation: moderation as 'auto' | 'low' } : {}),
      ...(typeof tool.output_compression === 'number' ? { output_compression: tool.output_compression } : {}),
      ...(typeof tool.partial_images === 'number' ? { partial_images: tool.partial_images } : {}),
      ...(typeof inputFidelity === 'string' ? { input_fidelity: inputFidelity as 'high' | 'low' } : {}),
      ...(mask !== undefined ? { mask } : {}),
      action: (typeof action === 'string' ? action : 'auto') as ImageGenerationConfig['action'],
    },
  }
}

// Validate every hosted `image_generation` entry; the LAST entry's config
// wins (most-recent declaration).
export const prepareImageGenerationConfig = (tools: readonly ResponsesTool[]): PrepareConfigResult => {
  let config: ImageGenerationConfig | undefined
  for (const [i, tool] of tools.entries()) {
    if (!isHostedImageGenerationTool(tool)) continue
    const validated = validateHostedImageGenerationEntry(tool, i)
    if (!validated.ok) return validated
    config = validated.config
  }
  if (config === undefined) return { ok: false, error: { message: 'No image_generation tool present.', param: 'tools', code: 'unknown_parameter' } }
  return { ok: true, config }
}

// Single optional `prompt` parameter — matches the native `image_gen.imagegen`
// tool's surface (size/quality/etc. are NOT model-chosen; the shim layers them
// on from the client config, exactly like Azure). A minimal description
// elicits native-quality refined prompts while costing ~50 input tokens vs
// the native hosted tool's ~2300.
export const buildImageGenerationFunctionTool = (_canonical: ResponsesHostedImageGenerationTool, name: string): ResponsesFunctionTool => ({
  type: 'function',
  name,
  description:
    'Generate an image from a text description, or edit an attached image per instructions. '
    + 'Use it whenever the user asks for a picture, drawing, illustration, photo, diagram, or any visual, '
    + 'or wants to modify an attached image. Generate directly without asking for confirmation, '
    + 'and do not describe or comment on the image after generating it. '
    // Agentic clients ship skill/plugin catalogs and tend to consult them
    // before acting: asked for a picture, the model goes looking for an
    // image-generation skill, finds one describing a local tool it does not
    // have, and reports the capability as unavailable — with the working tool
    // already in its own registry. Saying outright that this one is
    // self-sufficient short-circuits that detour.
    + 'This tool is self-contained: it needs no API key, no script, no setup, and no skill lookup. '
    + 'Call it directly instead of searching for an image-generation skill or CLI fallback.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image to generate or the edit to perform.' },
    },
    // Even `prompt` is optional on the native tool; the orchestrator may
    // call with no args and let the backend auto-prompt.
    required: [],
    additionalProperties: false,
  },
  // `strict: true` would require `required` to list every property; `prompt`
  // is intentionally optional, so the tool is non-strict.
  strict: false,
})

export const synthesizeImageGenerationCallId = (): string =>
  createRandomResponsesItemId('image_generation_call')

// ─────────────────────────────────────────────────────────────────────────
// 13-D-5-d: input-image collection + remote materialization
// ─────────────────────────────────────────────────────────────────────────

// Collect all image sources from the request input in forward declaration
// order: inline/remote `input_image` blocks in messages and function/custom
// tool outputs, and full-echo `image_generation_call` items carrying `result`
// bytes, each in the order they appear. Order is load-bearing: probing both
// the standalone /images/edits endpoint and native Responses showed gpt-image
// numbers the attached images positionally — a prompt that says "the
// first/second/last image" resolves against the order received — and native
// flattens every image across messages and tool results into this same
// forward order. Preserving declaration order therefore makes "the Nth image"
// mean the same thing here as it does natively.
export interface InputImageEntry {
  image: ResponsesInputImage
  path: string
}

export const inputImagesOf = (item: ResponsesInputItem, inputIndex: number): InputImageEntry[] => {
  const content = item.type === 'message'
    ? (item as { content?: unknown }).content
    : item.type === 'function_call_output' || item.type === 'custom_tool_call_output'
      ? (item as { output?: unknown }).output
      : undefined
  if (!Array.isArray(content)) return []
  const field = item.type === 'message' ? 'content' : 'output'
  return (content as unknown[]).flatMap((block, contentIndex) => {
    const b = block as { type?: string }
    return b.type === 'input_image'
      ? [{ image: block as ResponsesInputImage, path: `input[${inputIndex}].${field}[${contentIndex}]` }]
      : []
  })
}

export interface ImageOperationError {
  message: string
  errorType: string
  param: string | null
  code: string | null
}

export type RemoteImageFailure =
  | Exclude<ExternalImageFetchResult, { type: 'success' }>
  | { type: 'invalid-image' }
  | { type: 'aggregate-too-large' }

const INVALID_REMOTE_IMAGE_MESSAGE = "The image data you provided does not represent a valid image. Please check your input and try again with one of the supported image formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp']."
const REMOTE_IMAGE_TIMEOUT_MESSAGE = 'Unable to download content from the provided URL before the timeout. Check that the URL is publicly accessible and responds promptly, or upload the file and provide a file_id instead.'
const REMOTE_MASK_ERROR: ImageOperationError = {
  message: 'There was an issue with your request. Please check your inputs and try again',
  errorType: 'invalid_request_error',
  param: null,
  code: null,
}

export const invalidRemoteUrlError = (param: string): ImageOperationError => ({
  message: `Invalid '${param}'. Expected a valid URL, but got a value with an invalid format.`,
  errorType: 'invalid_request_error',
  param,
  code: 'invalid_value',
})

export const remoteInputError = (source: RemoteImageSource, failure: RemoteImageFailure): ImageOperationError => {
  if (failure.type === 'invalid-url') return invalidRemoteUrlError(source.invalidUrlParam)
  if (failure.type === 'invalid-image' || failure.type === 'empty-body') {
    return {
      message: INVALID_REMOTE_IMAGE_MESSAGE,
      errorType: 'invalid_request_error',
      param: 'input',
      code: 'invalid_value',
    }
  }
  if (failure.type === 'timeout') {
    return {
      message: REMOTE_IMAGE_TIMEOUT_MESSAGE,
      errorType: 'invalid_request_error',
      param: 'url',
      code: 'invalid_value',
    }
  }
  const status = failure.type === 'http-error' || failure.type === 'invalid-redirect'
    ? failure.status
    : undefined
  return {
    message: status === undefined
      ? 'Error while downloading file.'
      : `Error while downloading file. Upstream status code: ${status}.`,
    errorType: 'invalid_request_error',
    param: 'url',
    code: 'invalid_value',
  }
}

// The shared fetcher enforces the per-body limit while streaming. Native
// Responses additionally accepts at most 50 MB across all distinct successful
// image downloads, so account each memoized result once across sources and the
// mask.
// https://platform.openai.com/docs/guides/images-vision#image-input-requirements
const MAX_REMOTE_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024

export const supportedImageMimeFromBytes = (bytes: Uint8Array): string | null => {
  if (dimensionsFromBytes(bytes) === null) return null
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.subarray(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) return 'image/webp'
  return null
}

export const createRemoteImageMaterializer = (requestSignal: AbortSignal | undefined) => {
  // vNext external-image-loader takes { downstreamSignal }; reference took the
  // signal positionally. Behaviour is identical (abort propagation from the
  // request signal, 30 s timeout, 50 MiB size cap, URL memoization).
  const fetchImage = createExternalImageFetcher({ downstreamSignal: requestSignal })
  const materialized = new Map<string, ImageSource>()
  const materializedByData = new Map<Uint8Array, ImageSource>()
  let materializedBytes = 0

  const materialize = async (source: RemoteImageSource): Promise<
    { ok: true; source: ImageSource } | { ok: false; failure: RemoteImageFailure }
  > => {
    const fetched = await fetchImage(source.wireUrl)
    if (fetched.type !== 'success') return { ok: false, failure: fetched }

    const cached = materializedByData.get(fetched.data)
    if (cached !== undefined) return { ok: true, source: cached }

    const mimeType = supportedImageMimeFromBytes(fetched.data)
    if (mimeType === null) return { ok: false, failure: { type: 'invalid-image' } }
    if (materializedBytes + fetched.data.byteLength > MAX_REMOTE_IMAGE_TOTAL_BYTES) {
      return { ok: false, failure: { type: 'aggregate-too-large' } }
    }

    materializedBytes += fetched.data.byteLength
    const bytes = fetched.data.byteOffset === 0
      && fetched.data.buffer instanceof ArrayBuffer
      && fetched.data.byteLength === fetched.data.buffer.byteLength
      ? fetched.data.buffer
      : Uint8Array.from(fetched.data).buffer
    const result: ImageSource = { bytes, mimeType }
    materializedByData.set(fetched.data, result)
    return { ok: true, source: result }
  }

  return {
    async inputs(sources: readonly RemoteImageSource[]): Promise<{ ok: true } | { ok: false; error: ImageOperationError }> {
      for (const source of sources) {
        const result = await materialize(source)
        if (!result.ok) return { ok: false, error: remoteInputError(source, result.failure) }
        materialized.set(source.wireUrl, result.source)
      }
      return { ok: true }
    },
    async mask(source: RemoteImageSource): Promise<{ ok: true; source: ImageSource } | { ok: false; error: ImageOperationError }> {
      const result = await materialize(source)
      if (!result.ok) {
        return {
          ok: false,
          error: result.failure.type === 'invalid-url'
            ? invalidRemoteUrlError(source.invalidUrlParam)
            : REMOTE_MASK_ERROR,
        }
      }
      materialized.set(source.wireUrl, result.source)
      return { ok: true, source: result.source }
    },
    cached(source: RemoteImageSource): ImageSource {
      const result = materialized.get(source.wireUrl)
      if (result === undefined) {
        throw new Error('image_generation live source invariant violated after request validation: remote image URL was not materialized')
      }
      return result
    },
  }
}

export type RemoteImageMaterializer = ReturnType<typeof createRemoteImageMaterializer>

// ─────────────────────────────────────────────────────────────────────────
// 13-D-5-e: image source inspection + operation resolution
// ─────────────────────────────────────────────────────────────────────────

export type ImageSourceIssue =
  | { kind: 'native'; error: ImageOperationError }
  | { kind: 'gateway'; error: ImageOperationError }
  | { kind: 'invariant'; message: string }

export const inputImageDecodeError = (
  path: string,
  failure: Exclude<InputImageDecodeResult, { ok: true }>,
): ImageOperationError => {
  if (failure.reason === 'invalid_format') return invalidRemoteUrlError(path)
  const expected = `Invalid '${path}'. Expected a base64-encoded data URL with an image MIME type (e.g. 'data:image/png;base64,aW1nIGJ5dGVzIGhlcmU=')`
  const detail = failure.reason === 'missing_base64_separator'
    ? "a value without the ';base64' separator."
    : failure.reason === 'unsupported_mime'
      ? `unsupported MIME type '${failure.mimeType ?? ''}'.`
      : 'an invalid base64-encoded value.'
  return {
    message: `${expected}, but got ${detail}`,
    errorType: 'invalid_request_error',
    param: path,
    code: 'invalid_value',
  }
}

export interface ImageSourceInspection {
  sources: ImageSourceReference[]
  issue?: ImageSourceIssue
}

const inspectImageSourcesWithCache = (
  input: readonly ResponsesInputItem[],
  decodedSources: Map<string, ImageSource | null>,
): ImageSourceInspection => {
  const sources: ImageSourceReference[] = []
  let issue: ImageSourceIssue | undefined
  for (const [inputIndex, item] of input.entries()) {
    for (const { image, path } of inputImagesOf(item, inputIndex)) {
      const imageUrl = typeof image.image_url === 'string' && image.image_url.length > 0 ? image.image_url : null
      const fileIdField = (image as unknown as { file_id?: unknown }).file_id
      const fileId = typeof fileIdField === 'string' && fileIdField.length > 0 ? fileIdField : null
      if (imageUrl !== null && fileId !== null) {
        return {
          sources,
          issue: {
            kind: 'native',
            error: {
              message: `Mutually exclusive parameters: '${path}'. Ensure you are only providing one of: 'file_id' or 'image_url'.`,
              errorType: 'invalid_request_error',
              param: path,
              code: 'mutually_exclusive_parameters',
            },
          },
        }
      }
      if (imageUrl !== null) {
        if (/^https?:\/\//i.test(imageUrl)) {
          sources.push({ wireUrl: imageUrl, invalidUrlParam: `${path}.image_url` })
          continue
        }
        const decoded = decodeInputImageDataUrl(imageUrl, decodedSources)
        if (!decoded.ok) {
          return {
            sources,
            issue: { kind: 'native', error: inputImageDecodeError(`${path}.image_url`, decoded) },
          }
        }
        sources.push(decoded.source)
        continue
      }
      if (fileId !== null) {
        issue ??= {
          kind: 'gateway',
          error: {
            message: "Gateway cannot use file IDs as edit sources; provide an inline image data URL or set image_generation.action to 'generate'.",
            errorType: 'invalid_request_error',
            param: `${path}.file_id`,
            code: 'unsupported_image_source',
          },
        }
      } else {
        return {
          sources,
          issue: {
            kind: 'native',
            error: {
              message: `Missing mutually exclusive parameters: '${path}'. Ensure you are providing exactly one of: 'file_id' or 'image_url'.`,
              errorType: 'invalid_request_error',
              param: path,
              code: 'missing_mutually_exclusive_parameters',
            },
          },
        }
      }
    }
    if (item.type === 'image_generation_call') {
      const result = (item as { result?: unknown }).result
      if (typeof result === 'string' && result.length > 0) {
        // A prior generated image carries no MIME prefix on its bare-base64
        // `result`; pick the fallback from the echoed `output_format` so a
        // JPEG output is not mislabeled PNG on the edit form.
        const outputFormat = (item as { output_format?: unknown }).output_format
        const fallbackMime = outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png'
        const decoded = decodeInlineImage(result, fallbackMime, decodedSources)
        if (decoded === null) {
          return {
            sources,
            issue: {
              kind: 'invariant',
              message: `Stored image_generation_call at input[${inputIndex}] contains invalid result bytes.`,
            },
          }
        }
        sources.push(decoded)
      }
    }
  }
  return { sources, ...(issue === undefined ? {} : { issue }) }
}

export const createImageSourceInspector = (): ((input: readonly ResponsesInputItem[]) => ImageSourceInspection) => {
  const decodedSources = new Map<string, ImageSource | null>()
  return input => inspectImageSourcesWithCache(input, decodedSources)
}

export const inspectImageSources = (input: readonly ResponsesInputItem[]): ImageSourceInspection =>
  createImageSourceInspector()(input)

export type ImageOperation =
  | { ok: true; action: 'generate' | 'edit'; sources: readonly ImageSourceReference[] }
  | { ok: false; error: ImageOperationError }

export const resolveImageOperation = (
  config: ImageGenerationConfig,
  inspection: ImageSourceInspection,
): ImageOperation => {
  const { sources, issue } = inspection
  if (issue?.kind === 'native') return { ok: false, error: issue.error }
  if (issue?.kind === 'invariant') throw new Error(issue.message)
  if (issue?.kind === 'gateway' && config.action !== 'generate') return { ok: false, error: issue.error }

  const hasEditContext = sources.length > 0 || config.mask !== undefined
  const action = config.action === 'edit' || (config.action === 'auto' && hasEditContext)
    ? 'edit'
    : 'generate'

  if (config.action === 'edit' && !hasEditContext) {
    return {
      ok: false,
      error: {
        message: "ImageGenTool action 'edit' requires an image, mask, or previous context",
        errorType: 'image_generation_user_error',
        param: 'input',
        code: null,
      },
    }
  }

  const editSources = action === 'edit' && sources.length === 0 && config.mask !== undefined
    ? [config.mask]
    : sources
  return { ok: true, action, sources: action === 'edit' ? editSources : [] }
}

// ─── 5-f: candidate resolution + upstream invocation ───────────────────────
//
// Ported from copilot-gateway image-generation.ts lines 837-1145. Key vNext
// adaptations:
//   - reference `enumerateModelCandidates({ kind:'image', endpoints, scheduler,
//     runtimeLocation })` → vNext `enumerateBindingCandidates({ pickTarget })`
//     with `pickTarget` gating on `endpoints.images_edits`/`images_generations`
//     (snake_case vNext EndpointKeys).
//   - reference `enumerateResult.failedUpstreams` does not exist in vNext, so
//     `appendFailedUpstreams(msg, [])` is a no-op parity call.
//   - reference `provider.instance.callImagesGenerations/Edits(...)` →
//     unified `binding.provider.fetch({ endpoint, payload, headers, sourceApi,
//     flags, signal })`. Request body is a JSON object for /generations, and
//     the pre-serialized `BodyInit` (FormData or JSON string) from
//     `serializeOpenAIImagesEditsRequest` for /edits.
//   - reference `state.backgroundScheduler(promise)` → `waitUntil(promise)`
//     from `@vibe-core/platform`.
//   - `stampUpstreamCallStart` in vNext is a `(dispatch) => Promise<T>` wrapper
//     rather than a `wrapUpstreamCall` option, so it wraps the `provider.fetch`
//     call directly.
//   - `provider.fetch` returns framework `ProviderResponse
//     { status, headers, body: ReadableStream|null }` (NOT DOM `Response`), so
//     buffering goes through `new Response(body).text()`.
//   - `modelKey` in vNext is `binding.model.id` (reference used
//     `provider.instance.modelKey(...)`).
//   - `binding.provider.getPricingForModelKey(modelKey) ?? null` fills the
//     `cost` slot the vNext telemetry identity requires (reference field was
//     `pricing`).
import type { BindingScope, EndpointKey, ModelEndpoints } from '@vibe-llm/protocols/common'
import {
  serializeOpenAIImagesEditsRequest,
  type ImagesEditsRequest,
  type LlmProviderBinding,
  type ProviderResponse,
} from '@vibe-llm/provider-llm'
import { waitUntil } from '@vibe-core/platform'
import { sleep } from '../../../../../data-plane/shared/sleep.ts'
import { appendFailedUpstreams } from '../../../../../data-plane/shared/failed-upstreams.ts'
import { recordTokenUsage, tokenUsageFromImagesBody } from '../../../../../data-plane/shared/token-usage.ts'
import { stampUpstreamCallStart, type AttemptState } from '../../../../../data-plane/shared/gateway-ctx.ts'
import { enumerateBindingCandidates, type BindingCandidate } from '../../../../routing/candidates.ts'

// Standalone image backend error, normalized across HTTP transport /
// backend-body / dispatch-time exceptions. `retryable` lets the ReAct loop
// distinguish transient overload (worth another orchestrator turn) from a
// terminal content-policy or config error.
type ImageError = { type: string; code: string; message: string; retryable: boolean }

// Server-resolved tool config echoed by the backend on both the partial_image
// frames and the final result (`background:"auto"` becomes the concrete value
// the server picked, etc.). Read straight off the backend rather than inferred
// from the request, so what we surface matches what was actually rendered.
interface EchoFields {
  output_format?: 'png' | 'jpeg'
  quality?: 'low' | 'medium' | 'high'
  background?: 'transparent' | 'opaque'
  size?: string
}

export type ImageOutcome =
  | { ok: true; b64: string; echo: EchoFields }
  | { ok: false; error: ImageError }

// Project the server-resolved echo fields out of a backend payload (a response
// JSON body or an SSE event). Each field is validated against the public enum
// so a surprising backend value is dropped rather than echoed verbatim.
const extractEcho = (source: unknown): EchoFields => {
  if (source === null || typeof source !== 'object') return {}
  const s = source as Record<string, unknown>
  const echo: EchoFields = {}
  if (s.output_format === 'png' || s.output_format === 'jpeg') echo.output_format = s.output_format
  if (s.quality === 'low' || s.quality === 'medium' || s.quality === 'high') echo.quality = s.quality
  if (s.background === 'transparent' || s.background === 'opaque') echo.background = s.background
  if (typeof s.size === 'string') echo.size = s.size
  return echo
}

const RETRYABLE_IMAGE_ERROR_CODES = new Set([
  'EngineOverloaded', 'server_error', 'image_generation_server_error', 'image_generation_failed',
])

const isRetryableImageError = (code: string, type?: string): boolean =>
  RETRYABLE_IMAGE_ERROR_CODES.has(code) || (type !== undefined && RETRYABLE_IMAGE_ERROR_CODES.has(type))

const errorFromBody = (body: string, status: number): { type?: string; code: string; message: string } => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown; type?: unknown } }
    const err = parsed.error
    if (err !== undefined && err !== null) {
      return {
        ...(typeof err.type === 'string' ? { type: err.type } : {}),
        message: typeof err.message === 'string' ? err.message : `Image backend returned HTTP ${status}`,
        code: typeof err.code === 'string' ? err.code : `upstream_${status}`,
      }
    }
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
  }
  return { message: `Image backend returned HTTP ${status}`, code: `upstream_${status}` }
}

// Per-request inputs the dispatcher's backend call needs. Captured in the
// registration closure from `ctx`/`request` so the dispatcher stays free of the
// interceptor signature. Edit sources are NOT captured here — they are
// re-collected from the live `ctx.payload.input` at dispatch time so an image
// generated in an earlier turn (fed back as an `input_image`) becomes editable
// in a later turn. `imageDispatchCount` bounds how many real backend image
// calls one response may issue.
//
// vNext deviation from reference: no `backgroundScheduler` or `runtimeLocation`
// fields — the plugin uses process-global `waitUntil()` and `getRuntimeLocation()`
// from `@vibe-core/platform` (see file-header adaptation notes).
export interface ShimState {
  config: MaterializedImageGenerationConfig
  apiKeyId: ApiKeyId
  upstreamIds: readonly string[] | null
  /** Visibility scope of the enclosing request. The image sub-call resolves a
   *  *different* model on a *different* endpoint than the orchestrator turn, so
   *  it re-enumerates — and must do so under the caller's scope. */
  bindingScope: BindingScope | undefined
  downstreamAbortSignal: AbortSignal | undefined
  imageDispatchCount: number
}

const recordImageUsage = (
  state: ShimState,
  binding: LlmProviderBinding,
  modelKey: string,
  responseBody: unknown,
): void => {
  const usage = tokenUsageFromImagesBody(responseBody)
  if (usage === null) return
  const promise = recordTokenUsage(state.apiKeyId, {
    model: binding.model.id,
    upstream: binding.upstream,
    modelKey,
    cost: binding.provider.getPricingForModelKey(modelKey) ?? null,
  }, usage).catch((error: unknown) => {
    console.error('Failed to record image generation usage:', error)
  })
  waitUntil(promise)
}

const buildGenerationsBody = (
  prompt: string,
  config: ImageGenerationConfig,
  stream: boolean,
): Record<string, unknown> => ({
  prompt,
  // Public Responses tool config forbids `n`, but the private standalone
  // backend call always requests a single image, mirroring Azure's
  // single-image Responses behavior.
  n: 1,
  // `response_format` is intentionally not sent: gpt-image-* always returns
  // base64 (`data[0].b64_json`) and rejects `response_format`, so the inline
  // extraction below reads `b64_json` directly.
  ...(config.size !== undefined ? { size: config.size } : {}),
  ...(config.quality !== undefined ? { quality: config.quality } : {}),
  ...(config.output_format !== undefined ? { output_format: config.output_format } : {}),
  ...(config.background !== undefined ? { background: config.background } : {}),
  ...(config.moderation !== undefined ? { moderation: config.moderation } : {}),
  ...(config.output_compression !== undefined ? { output_compression: config.output_compression } : {}),
  ...(stream ? { stream: true, partial_images: config.partial_images } : {}),
})

const buildEditsRequest = (
  prompt: string,
  config: ImageGenerationConfig,
  sources: readonly PreparedImageSource[],
  mask: PreparedImageSource | undefined,
  stream: boolean,
): ImagesEditsRequest => {
  const parameters: Record<string, string | number | boolean> = {
    prompt,
    n: 1,
    ...(config.size === undefined ? {} : { size: config.size }),
    ...(config.quality === undefined ? {} : { quality: config.quality }),
    ...(config.output_format === undefined ? {} : { output_format: config.output_format }),
    ...(config.background === undefined ? {} : { background: config.background }),
    ...(config.moderation === undefined ? {} : { moderation: config.moderation }),
    ...(config.output_compression === undefined ? {} : { output_compression: config.output_compression }),
    ...(config.input_fidelity === undefined ? {} : { input_fidelity: config.input_fidelity }),
    ...(stream ? { stream: true, partial_images: config.partial_images } : {}),
  }
  const images = sources.map((source, index) => ({
    type: 'upload' as const,
    file: new File([source.bytes], `image_${index}.${editFileExt(source.mimeType)}`, { type: source.mimeType }),
  }))
  const maskFile = mask === undefined
    ? undefined
    : new File([mask.bytes], `mask.${editFileExt(mask.mimeType)}`, { type: mask.mimeType })
  return {
    images,
    ...(maskFile === undefined ? {} : { mask: { type: 'upload' as const, file: maskFile } }),
    parameters,
  }
}

const serverError = (e: unknown): ImageError => ({
  type: 'image_generation_error',
  message: e instanceof Error ? e.message : String(e),
  code: 'server_error',
  retryable: true,
})

// Resolve the candidate that serves the configured image model for the
// target endpoint. A resolution/availability failure is normalized into
// an `ImageError` so the caller always produces a terminal image item.
const resolveImageCandidate = async (
  isEdit: boolean,
  state: ShimState,
): Promise<{ ok: true; candidate: BindingCandidate } | { ok: false; error: ImageError }> => {
  const endpointKey: EndpointKey = isEdit ? 'images_edits' : 'images_generations'
  const endpointPath = isEdit ? '/images/edits' : '/images/generations'
  const pickTarget = (endpoints: ModelEndpoints): EndpointKey | null =>
    endpoints[endpointKey] !== undefined ? endpointKey : null
  let resolution
  try {
    resolution = await enumerateBindingCandidates({
      model: state.config.model,
      pickTarget,
      // Scope this enumeration to what the caller can see. Without it
      // `listVisibleUpstreams(undefined)` returns only globally-owned
      // upstreams, and an owner-scoped image model resolves to
      // `sawModel:false` — i.e. "no upstream provides model 'X'" for a model
      // the same key serves fine on `POST /v1/images/generations`.
      //
      // `upstreamIds` below is a second, narrower filter (the caller's pinned
      // set) applied post-enumeration; it cannot substitute for the scope,
      // which decides what is enumerable in the first place.
      opts: { ...(state.bindingScope ?? {}) },
    })
  } catch (e) {
    return { ok: false, error: serverError(e) }
  }
  const filtered = state.upstreamIds === null || state.upstreamIds === undefined
    ? resolution.candidates
    : resolution.candidates.filter(c => state.upstreamIds!.includes(c.binding.upstream))
  const match = filtered[0]
  serverToolTrace('image.resolve', {
    requestedModel: state.config.model,
    endpoint: endpointKey,
    sawModel: resolution.sawModel,
    scopedToOwner: state.bindingScope?.ownerId !== undefined,
    candidates: resolution.candidates.length,
    afterUpstreamFilter: filtered.length,
    upstreamPin: state.upstreamIds ?? null,
    chosen: match === undefined
      ? null
      : { upstream: match.binding.upstream, modelKey: match.binding.model.id, targetEndpoint: match.targetEndpoint },
  })
  if (match !== undefined) {
    return { ok: true, candidate: match }
  }
  // Split on the resolver's `sawModel` signal the same way serve-prep.ts
  // does for chat: an unknown model id ("model_not_found", 404-shaped) vs
  // a model that exists under some catalog but cannot serve this op
  // ("model_not_supported"). The latter splits further on whether the
  // resolver's kind filter rejected the id (sawModel=true, candidates=[]:
  // id exists but not as an image model) or the per-endpoint key did
  // (candidates non-empty: image-kind upstreams exist but none expose the
  // requested edits/generations endpoint).
  //
  // vNext deviation: reference tracked per-request `failedUpstreams` (upstreams
  // that already errored earlier in this request); vNext registry does not
  // surface that list, so `appendFailedUpstreams(msg, [])` degrades to identity.
  if (!resolution.sawModel) {
    return {
      ok: false,
      error: {
        type: 'image_generation_error',
        message: appendFailedUpstreams(`No upstream provides model '${state.config.model}'.`, []),
        code: 'model_not_found',
        retryable: false,
      },
    }
  }
  const message = resolution.candidates.length === 0
    ? `Model '${state.config.model}' is not an image model.`
    : `No upstream supporting the ${endpointPath} endpoint provides model '${state.config.model}'.`
  return {
    ok: false,
    error: {
      type: 'image_generation_error',
      message: appendFailedUpstreams(message, []),
      code: 'model_not_supported',
      retryable: false,
    },
  }
}

// 60s cap matches the per-minute refill window of Azure TPM/RPM and
// openai.com tier image quotas — same clamp openai-python applies in
// [`_calculate_retry_timeout`](https://github.com/openai/openai-python/blob/d76d8c11c1da9f97aa8a0aaee8ccd44d2bc8f5e7/src/openai/_base_client.py#L789).
const RETRY_CAP_MS = 60_000
const MAX_RATE_LIMIT_RETRIES = 2

// Header priority matches openai-python's `_parse_retry_after_header` with
// Azure's `x-ms-retry-after-ms` alias added. Treats <= 0 as "no hint" so the
// gpt-image-1 `retry-after: 0.0` quirk falls back to backoff instead of
// pretending the quota is free.
export const parseRetryAfterMs = (headers: Headers): number | null => {
  for (const name of ['retry-after-ms', 'x-ms-retry-after-ms']) {
    const raw = headers.get(name)
    if (raw === null) continue
    const ms = Number(raw)
    if (Number.isFinite(ms) && ms > 0) return ms
  }
  const ra = headers.get('retry-after')
  if (ra !== null) {
    const seconds = Number(ra)
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
    const httpDateMs = Date.parse(ra)
    if (!Number.isNaN(httpDateMs)) {
      const delta = httpDateMs - Date.now()
      if (delta > 0) return delta
    }
  }
  return null
}

// On 429, sleep for the upstream's retry hint (or jittered exponential
// backoff when absent) and replay the same backend call up to
// MAX_RATE_LIMIT_RETRIES times. The returned `response` always has a fresh,
// unread body — intermediate failed responses are drained inside the loop so
// the underlying socket can be reused while we sleep.
const issueImageCall = async (
  candidate: BindingCandidate,
  prompt: string,
  editRequest: ImagesEditsRequest | null,
  config: ImageGenerationConfig,
  state: ShimState,
  stream: boolean,
  attempt: AttemptState,
): Promise<{ response: ProviderResponse; modelKey: string }> => {
  const { binding, targetEndpoint } = candidate
  const modelKey = binding.model.id
  for (let retry = 0; ; retry++) {
    const payload: unknown = editRequest === null
      ? buildGenerationsBody(prompt, config, stream)
      // Pre-serialize the edits request into the FormData/JSON BodyInit the
      // upstream provider will forward. `serializeOpenAIImagesEditsRequest`
      // hides the multipart-vs-JSON decision behind the ImagesEditsRequest
      // shape; providers accept `BodyInit` as an already-serialized payload.
      : await serializeOpenAIImagesEditsRequest(editRequest, modelKey)
    // Stamp this image sub-call's OWN perf slot — never the outer request's
    // attempt — so the enclosing Responses turn's upstream-call stamp is
    // preserved. The retry loop overwrites this slot each retry so it reflects
    // the dispatch that actually returned.
    const response = await stampUpstreamCallStart(attempt)(() =>
      binding.provider.fetch({
        endpoint: targetEndpoint,
        payload,
        headers: new Headers(),
        sourceApi: 'openai',
        flags: { isStreaming: stream, hasImageGen: true },
        signal: state.downstreamAbortSignal,
      }),
    )
    if (response.status !== 429 || retry >= MAX_RATE_LIMIT_RETRIES) {
      serverToolTrace('image.upstream', {
        upstream: binding.upstream,
        modelKey,
        endpoint: targetEndpoint,
        status: response.status,
        retries: retry,
        stream,
      })
      return { response, modelKey }
    }

    // 25% jitter desynchronizes parallel callers so a burst of orchestrator
    // turns doesn't all re-issue at the same instant.
    const base = 1000 * 2 ** retry
    const backoffMs = base + Math.random() * base * 0.25
    const delayMs = Math.min(parseRetryAfterMs(response.headers) ?? backoffMs, RETRY_CAP_MS)
    // Drain the discarded 429 body so the transport can pool the connection.
    if (response.body !== null) {
      await new Response(response.body).text().catch(() => undefined)
    }
    await sleep(delayMs, state.downstreamAbortSignal)
  }
}

// Consume a non-streaming backend response (partial_images = 0) into an
// outcome. Transport/backend failures become `{ok:false}` rather than
// throwing, so the caller always produces a terminal image item.
const consumeImageResponse = async (
  candidate: BindingCandidate,
  modelKey: string,
  response: ProviderResponse,
  state: ShimState,
): Promise<ImageOutcome> => {
  const text = response.body === null ? '' : await new Response(response.body).text()
  const ok = response.status >= 200 && response.status < 300
  if (!ok) {
    const { type, code, message } = errorFromBody(text, response.status)
    return { ok: false, error: { type: type ?? 'image_generation_error', code, message, retryable: isRetryableImageError(code, type) } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: { type: 'image_generation_error', message: 'Image backend returned a non-JSON success body.', code: 'server_error', retryable: true } }
  }
  const b64 = (() => {
    if (parsed === null || typeof parsed !== 'object') return null
    const data = (parsed as { data?: unknown }).data
    if (!Array.isArray(data) || data.length === 0) return null
    const first = data[0] as { b64_json?: unknown }
    return typeof first.b64_json === 'string' ? first.b64_json : null
  })()
  if (b64 === null) {
    return { ok: false, error: { type: 'image_generation_error', message: 'Image backend response did not contain image bytes.', code: 'server_error', retryable: true } }
  }
  recordImageUsage(state, candidate.binding, modelKey, parsed)
  return { ok: true, b64, echo: extractEcho(parsed) }
}

import type {
  ServerToolLifecycleEvent,
  ServerToolOutputItem,
  ServerToolTerminal,
} from '../../../../orchestrator/server-tools/types.ts'
import type {
  ResponsesOutputImageGenerationCall,
  ResponsesOutputFunctionCall,
  ResponsesFunctionCallOutputItem,
} from '@vibe-llm/protocols/responses'
import { parseSSEStream } from '@vibe-core/result/parse'
import { getRuntimeLocation } from '@vibe-core/platform'
import { recordImagePerformance } from '../../../../../data-plane/shared/gateway-ctx.ts'

// Terminal image_generation_call item + its close event. `id` is left off so
// the orchestrator can mint one (matching the deferred-slot lifecycle contract
// in ServerToolTerminal.item).
export const imageTerminal = (
  prompt: string,
  action: 'generate' | 'edit',
  outcome: ImageOutcome,
): ServerToolTerminal => {
  if (!outcome.ok) {
    const item: ServerToolOutputItem & Omit<ResponsesOutputImageGenerationCall, 'id'> = {
      type: 'image_generation_call',
      status: 'failed',
      revised_prompt: prompt,
      error: { message: outcome.error.message, code: outcome.error.code, type: outcome.error.type },
    }
    return { item, endEvents: [] }
  }
  const item: ServerToolOutputItem & Omit<ResponsesOutputImageGenerationCall, 'id'> = {
    type: 'image_generation_call',
    status: 'completed',
    action,
    result: outcome.b64,
    revised_prompt: prompt,
    ...outcome.echo,
  }
  return { item, endEvents: [{ type: 'response.image_generation_call.completed' }] }
}

// One standalone-images SSE data line folded into a backend-agnostic signal.
// Both `image_generation.*` and `image_edit.*` event prefixes are matched via
// suffix only.
type ImageStreamSignal =
  | { kind: 'partial'; index: number; b64: string; echo: EchoFields }
  | { kind: 'completed'; b64: string | undefined; usage: unknown; echo: EchoFields }
  | { kind: 'error'; error: ImageError }
  | null

export const parseImageStreamEvent = (data: string): ImageStreamSignal => {
  let evt: { type?: unknown; partial_image_index?: unknown; b64_json?: unknown; usage?: unknown; error?: unknown }
  try {
    evt = JSON.parse(data)
  } catch {
    return null
  }
  const type = typeof evt.type === 'string' ? evt.type : ''
  if (type.endsWith('.partial_image')) {
    return {
      kind: 'partial',
      index: typeof evt.partial_image_index === 'number' ? evt.partial_image_index : 0,
      b64: typeof evt.b64_json === 'string' ? evt.b64_json : '',
      echo: extractEcho(evt),
    }
  }
  if (type.endsWith('.completed')) {
    return { kind: 'completed', b64: typeof evt.b64_json === 'string' ? evt.b64_json : undefined, usage: evt.usage, echo: extractEcho(evt) }
  }
  if (type === 'error') {
    const err = evt.error as { message?: unknown; code?: unknown; type?: unknown } | undefined
    const code = typeof err?.code === 'string' ? err.code : 'server_error'
    const errType = typeof err?.type === 'string' ? err.type : 'image_generation_error'
    return {
      kind: 'error',
      error: { type: errType, code, message: typeof err?.message === 'string' ? err.message : 'Image backend stream reported an error.', retryable: isRetryableImageError(code, errType) },
    }
  }
  return null
}

// Drive the backend and produce the deferred slot lifecycle: relay each
// progressively-rendered preview as a native `partial_image` frame, then
// return the terminal `image_generation_call` item. partial_images = 0 (or
// absent) takes a single non-streaming round-trip and yields no preview frames.
//
// Every sub-call records its OWN perf row under operation='image_generation'
// or 'image_edit' via a local AttemptState distinct from the outer request's
// attempt. Resolution failures record no row: no upstream was ever dispatched.
export const streamImageGeneration = (
  prompt: string,
  action: 'generate' | 'edit',
  isEdit: boolean,
  sources: readonly ImageSource[],
  state: ShimState,
) => async function* (): AsyncGenerator<ServerToolLifecycleEvent, ServerToolTerminal> {
  const resolved = await resolveImageCandidate(isEdit, state)
  if (!resolved.ok) return imageTerminal(prompt, action, { ok: false, error: resolved.error })
  const { binding } = resolved.candidate
  const wantsPartials = (state.config.partial_images ?? 0) > 0

  const attempt: AttemptState = { upstreamCallStartedAt: null, firstOutputTokenAt: null, telemetry: undefined }
  const runtimeLocation = getRuntimeLocation()
  const finish = (outcome: ImageOutcome): ServerToolTerminal => {
    serverToolTrace('image.terminal', {
      action,
      upstream: binding.upstream,
      modelKey: binding.model.id,
      ok: outcome.ok,
      ...(outcome.ok ? { b64Bytes: outcome.b64.length } : { code: outcome.error.code, message: outcome.error.message }),
    })
    void recordImagePerformance({
      apiKeyId: state.apiKeyId,
      attempt,
      model: binding.model.id,
      upstream: binding.upstream,
      runtimeLocation,
      operation: isEdit ? 'image_edit' : 'image_generation',
      failed: !outcome.ok,
    }).catch((error: unknown) => {
      console.error('Failed to record image generation perf:', error)
    })
    return imageTerminal(prompt, action, outcome)
  }

  let response: ProviderResponse
  let modelKey: string
  try {
    let editRequest: ImagesEditsRequest | null = null
    if (isEdit) {
      const prepared = await prepareEditRequest(sources, state.config)
      editRequest = buildEditsRequest(prompt, state.config, prepared.sources, prepared.mask, wantsPartials)
    }
    ({ response, modelKey } = await issueImageCall(
      resolved.candidate,
      prompt,
      editRequest,
      state.config,
      state,
      wantsPartials,
      attempt,
    ))
  } catch (e) {
    return finish({ ok: false, error: serverError(e) })
  }

  if (!wantsPartials) {
    return finish(await consumeImageResponse(resolved.candidate, modelKey, response, state))
  }

  const okStatus = response.status >= 200 && response.status < 300
  if (!okStatus) {
    const body = response.body === null ? '' : await new Response(response.body).text()
    const { type, code, message } = errorFromBody(body, response.status)
    return finish({ ok: false, error: { type: type ?? 'image_generation_error', code, message, retryable: isRetryableImageError(code, type) } })
  }
  if (response.body === null) {
    return finish({ ok: false, error: { type: 'image_generation_error', message: 'Image backend returned a streaming response with no body.', code: 'server_error', retryable: true } })
  }

  let finalB64: string | undefined
  let finalEcho: EchoFields = {}
  let usage: unknown
  for await (const frame of parseSSEStream(response.body, { signal: state.downstreamAbortSignal })) {
    const signal = parseImageStreamEvent(frame.data)
    if (signal === null) continue
    if (signal.kind === 'partial') {
      yield { type: 'response.image_generation_call.partial_image', partial_image_index: signal.index, partial_image_b64: signal.b64, ...signal.echo }
    } else if (signal.kind === 'completed') {
      finalB64 = signal.b64
      finalEcho = signal.echo
      usage = signal.usage
    } else {
      return finish({ ok: false, error: signal.error })
    }
  }
  if (finalB64 === undefined) {
    return finish({ ok: false, error: { type: 'image_generation_error', message: 'Image backend stream ended without a completed image.', code: 'server_error', retryable: true } })
  }
  recordImageUsage(state, binding, modelKey, { usage })
  return finish({ ok: true, b64: finalB64, echo: finalEcho })
}

// Output-as-input round-trip: the multi-turn loop feeds accumulated
// `image_generation_call` items back as the next turn's input, and client
// histories may echo prior ones. Non-Responses upstreams can't read the item
// type, so rewrite each into a `function_call` + `function_call_output` pair
// so the orchestrator sees that it called the tool and what it returned. For a
// successful call we additionally surface the generated bytes as an
// `input_image` message, matching Azure's native flow where the image stays in
// the orchestrator's multimodal context so the model can describe or
// iteratively edit what it just produced.
export const transformInputItemsForImageGeneration = (
  input: ResponsesInputItem[],
  toolName: string,
): ResponsesInputItem[] => {
  const out: ResponsesInputItem[] = []
  for (const item of input) {
    if (item.type !== 'image_generation_call') {
      out.push(item)
      continue
    }
    // vNext ResponsesInputItem is a loose permissive shape; alias to the
    // narrowed image_generation_call structure.
    const ig = item as ResponsesInputItem & {
      id?: string
      status?: string
      revised_prompt?: string
      result?: string
      output_format?: string
      error?: { message?: string; code?: string; type?: string }
    }
    const id = ig.id !== undefined && ig.id.length > 0 ? ig.id : synthesizeImageGenerationCallId()
    const callId = `cc_from_${id}`
    const output = ig.status === 'failed'
      ? JSON.stringify({
          ok: false,
          error: {
            type: ig.error?.type ?? 'image_generation_error',
            code: ig.error?.code ?? 'server_error',
            message: ig.error?.message ?? 'Image generation failed.',
            retryable: isRetryableImageError(ig.error?.code ?? '', ig.error?.type),
          },
        })
      : JSON.stringify({ ok: true, status: 'completed', id })
    const functionCall: ResponsesOutputFunctionCall = {
      type: 'function_call',
      call_id: callId,
      name: toolName,
      arguments: JSON.stringify({ prompt: ig.revised_prompt ?? '' }),
      status: 'completed',
    }
    const functionCallOutput: ResponsesFunctionCallOutputItem = {
      type: 'function_call_output',
      call_id: callId,
      output,
    }
    out.push(functionCall as unknown as ResponsesInputItem, functionCallOutput as unknown as ResponsesInputItem)

    if (ig.status !== 'failed' && typeof ig.result === 'string' && ig.result.length > 0) {
      const mime = ig.output_format === 'jpeg' ? 'image/jpeg' : 'image/png'
      out.push({
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Generated image:' },
          { type: 'input_image', image_url: `data:${mime};base64,${ig.result}`, detail: 'auto' },
        ],
      } as unknown as ResponsesInputItem)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Spec 13-D-5-i: top-level plugin registration.
// ---------------------------------------------------------------------------
import type {
  ServerToolRegistration,
  ServerToolRequestCtx,
} from '../../../../orchestrator/server-tools/types.ts'
import type { Invocation } from '@vibe-llm/protocols/common'

export const imageGenerationServerTool: ServerToolRegistration<Invocation, ServerToolRequestCtx> = async (
  invocation,
  requestCtx,
) => {
  if (!invocation.enabledFlags.has('responses-image-generation-shim')) {
    return { type: 'inactive' }
  }

  const tools = Array.isArray(invocation.payload.tools) ? (invocation.payload.tools as ResponsesTool[]) : []
  const hasHostedTool = tools.some(isHostedImageGenerationTool)
  const input = Array.isArray(invocation.payload.input) ? (invocation.payload.input as ResponsesInputItem[]) : []
  const hasReplayInput = input.some((i) => i.type === 'image_generation_call')
  if (!hasHostedTool && !hasReplayInput) return { type: 'inactive' }

  if (!hasHostedTool) {
    // Replay-only activation: rewrite echoed image_generation_call items so
    // the upstream can read them, but there is no hosted tool to dispatch.
    return {
      type: 'active',
      baseToolName: SHIM_TOOL_NAME,
      transformItems: transformInputItemsForImageGeneration,
    }
  }

  const prepared = prepareImageGenerationConfig(tools)
  if (!prepared.ok) {
    return {
      type: 'invalid-request',
      message: prepared.error.message,
      param: prepared.error.param,
      code: prepared.error.code,
    }
  }
  const config = prepared.config
  const inspectSources = createImageSourceInspector()
  const initialInspection = inspectSources(input)
  const initialOperation = resolveImageOperation(config, initialInspection)
  if (!initialOperation.ok) {
    return {
      type: 'invalid-request',
      message: initialOperation.error.message,
      param: initialOperation.error.param ?? 'input',
      ...(initialOperation.error.code !== null ? { code: initialOperation.error.code } : {}),
    }
  }

  const materializer = createRemoteImageMaterializer(requestCtx.abortSignal)
  const remoteInputs = initialInspection.sources.filter(isRemoteImageSource)
  const materializedInputs = await materializer.inputs(remoteInputs)
  if (!materializedInputs.ok) {
    return {
      type: 'invalid-request',
      message: materializedInputs.error.message,
      param: materializedInputs.error.param ?? 'input',
      ...(materializedInputs.error.code !== null ? { code: materializedInputs.error.code } : {}),
    }
  }
  let mask: ImageSource | undefined
  if (config.mask !== undefined) {
    if (isRemoteImageSource(config.mask)) {
      const remoteMask = config.mask
      const materializedMask = await materializer.mask(remoteMask)
      if (!materializedMask.ok) {
        return {
          type: 'invalid-request',
          message: materializedMask.error.message,
          param: materializedMask.error.param ?? 'input',
          ...(materializedMask.error.code !== null ? { code: materializedMask.error.code } : {}),
        }
      }
      if (remoteMask.afterMaterializationError !== undefined) {
        return {
          type: 'invalid-request',
          message: remoteMask.afterMaterializationError.message,
          param: remoteMask.afterMaterializationError.param,
          code: remoteMask.afterMaterializationError.code,
        }
      }
      mask = materializedMask.source
    } else {
      mask = config.mask
    }
  }
  const { mask: _unmaterializedMask, ...configWithoutMask } = config
  const materializedConfig: MaterializedImageGenerationConfig = {
    ...configWithoutMask,
    ...(mask === undefined ? {} : { mask }),
  }

  const state: ShimState = {
    config: materializedConfig,
    apiKeyId: requestCtx.apiKeyId,
    upstreamIds: requestCtx.upstreamIds ?? null,
    bindingScope: requestCtx.bindingScope,
    downstreamAbortSignal: requestCtx.abortSignal,
    imageDispatchCount: 0,
  }

  return {
    type: 'active',
    baseToolName: SHIM_TOOL_NAME,
    transformItems: transformInputItemsForImageGeneration,
    hosted: {
      hostedTypes: ['image_generation'],
      canonicalize: canonicalizeImageGenerationTool,
      buildFunctionTool: (canonical, name) =>
        buildImageGenerationFunctionTool(canonical as ResponsesHostedImageGenerationTool, name),
      dispatcher: ({ intercepted }) => {
        const promptArg =
          intercepted.arguments !== null && typeof intercepted.arguments.prompt === 'string'
            ? intercepted.arguments.prompt
            : ''
        const id = synthesizeImageGenerationCallId()
        // Later ReAct turns include prior server-tool output in the live input.
        // Resolve and validate again so action:auto can pivot from generation
        // to editing without bypassing the same source policy used at ingress.
        const liveInput = Array.isArray(invocation.payload.input)
          ? (invocation.payload.input as ResponsesInputItem[])
          : []
        const operation = resolveImageOperation(materializedConfig, inspectSources(liveInput))
        if (!operation.ok) {
          throw new Error(
            `image_generation live source invariant violated after request validation: ${operation.error.message}`,
          )
        }
        const sources = operation.sources.map((source) =>
          isRemoteImageSource(source) ? materializer.cached(source) : source,
        )

        // Safety valve against an unbounded backend-call loop (the model
        // retrying after repeated {ok:false} outcomes): once this response has
        // issued IMAGE_ITERATION_CAP real backend image calls, stop hitting the
        // backend and replay an exhausted tool output so the model steers
        // toward a terminal answer.
        if (state.imageDispatchCount >= IMAGE_ITERATION_CAP) {
          return [
            {
              id,
              startItem: { type: 'image_generation_call', status: 'in_progress' },
              startEvents: [
                { type: 'response.image_generation_call.in_progress' },
                { type: 'response.image_generation_call.generating' },
              ],
              async *run() {
                return imageTerminal(promptArg, 'generate', {
                  ok: false,
                  error: {
                    type: 'image_generation_error',
                    code: 'tool_call_budget_exhausted',
                    message: `Image generation budget (${IMAGE_ITERATION_CAP} attempts) reached for this response. Summarize and finish without another image.`,
                    retryable: false,
                  },
                })
              },
            },
          ]
        }
        state.imageDispatchCount += 1

        return [
          {
            id,
            startItem: { type: 'image_generation_call', status: 'in_progress' },
            startEvents: [
              { type: 'response.image_generation_call.in_progress' },
              { type: 'response.image_generation_call.generating' },
            ],
            run: streamImageGeneration(promptArg, operation.action, operation.action === 'edit', sources, state),
          },
        ]
      },
    },
  }
}
