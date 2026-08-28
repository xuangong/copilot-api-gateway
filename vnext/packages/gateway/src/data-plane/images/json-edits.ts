/**
 * JSON → multipart normalization for `POST /images/edits`.
 *
 * The OpenAI-documented shape for image edits is `multipart/form-data`, and
 * that is what every SDK sends. Codex's client-owned image extension does not:
 * it serializes `ImageEditRequest` as plain JSON and POSTs that to
 * `{base_url}/images/edits` —
 *
 *   {"images":[{"image_url":"data:image/png;base64,..."}],
 *    "prompt":"...","background":"auto","model":"gpt-image-2",
 *    "quality":"auto","size":"auto"}
 *
 * (codex-rs/codex-api/src/images.rs:18-31 declares the struct;
 *  codex-rs/codex-api/src/endpoint/images.rs:58-68 encodes it with `to_value`
 *  and posts it as the request body, same as generations.)
 *
 * Referenced images always arrive as base64 data URLs, never remote links —
 * both the on-disk path (`into_data_url()`, tool.rs:565-567) and the
 * conversation-history path (`format!("data:image/png;base64,{result}")`,
 * tool.rs:498) produce inline data.
 *
 * Upstreams speak the documented multipart shape (verified against sdf), so we
 * decode the data URLs here and rebuild the FormData the edits handler already
 * knows how to forward. That keeps the provider seam untouched: providers still
 * receive a FormData for `images_edits` no matter which wire shape came in.
 */

export type JsonEditsResult =
  | { ok: true; model: string; form: FormData }
  | { ok: false; message: string }

interface ParsedDataUrl {
  mimeType: string
  base64: string
}

/**
 * Accepts `data:image/<subtype>;base64,<payload>`. Anything else — remote
 * https links, `file_id` references, non-image media types — returns null so
 * the caller can reject with a message that says why.
 */
export function parseBase64ImageDataUrl(value: string): ParsedDataUrl | null {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(value.trim())
  if (!match || match[1] === undefined || match[2] === undefined) return null
  const mimeType = match[1].trim().toLowerCase()
  if (!mimeType.startsWith('image/')) return null
  return { mimeType, base64: match[2].trim() }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Returns a File, or a human-readable reason the reference is unusable.
 */
function fileFromReference(value: unknown, index: number, label: string): File | string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${label} must be an object with an image_url.`
  }
  const { image_url: imageUrl } = value as { image_url?: unknown }
  if (typeof imageUrl !== 'string' || imageUrl.length === 0) {
    return `${label} must contain a string image_url.`
  }
  const parsed = parseBase64ImageDataUrl(imageUrl)
  if (!parsed) {
    return `${label} image_url must be a base64 image data URL (data:image/...;base64,...); remote URLs and file ids are not supported.`
  }
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(parsed.base64)
  } catch {
    return `${label} image_url is not valid base64.`
  }
  if (bytes.length === 0) return `${label} image_url decoded to an empty image.`
  const subtype = parsed.mimeType.slice('image/'.length)
  const extension = /^[a-z0-9]+$/.test(subtype) ? subtype : 'png'
  return new File([bytes as BlobPart], `${label.replace(/\W+/g, '-')}-${index}.${extension}`, { type: parsed.mimeType })
}

export function formDataFromJsonEdits(raw: unknown): JsonEditsResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: '/images/edits JSON body must be an object' }
  }
  const body = raw as Record<string, unknown>

  const model = body.model
  if (typeof model !== 'string' || model.length === 0) {
    return { ok: false, message: 'model is required' }
  }
  if (!Array.isArray(body.images) || body.images.length === 0) {
    return { ok: false, message: '/images/edits JSON body must include a non-empty images array' }
  }

  const files: File[] = []
  for (const [index, entry] of body.images.entries()) {
    const file = fileFromReference(entry, index, 'images')
    if (typeof file === 'string') return { ok: false, message: file }
    files.push(file)
  }

  let mask: File | undefined
  if (body.mask !== undefined && body.mask !== null) {
    const file = fileFromReference(body.mask, 0, 'mask')
    if (typeof file === 'string') return { ok: false, message: file }
    mask = file
  }

  const form = new FormData()
  // Everything that isn't a recognized structural key rides along as a scalar
  // form field — prompt, background, quality, size, n, output_format, … We do
  // not whitelist them: the upstream owns which parameters it accepts, and a
  // whitelist here would silently drop new ones.
  for (const [key, value] of Object.entries(body)) {
    if (key === 'model' || key === 'images' || key === 'mask') continue
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      form.append(key, String(value))
      continue
    }
    return { ok: false, message: `/images/edits JSON field ${key} must be a string, number, or boolean` }
  }
  form.append('model', model)

  // Single image goes on `image`, multiple on `image[]` — the convention the
  // OpenAI images API documents and every upstream expects.
  const imageField = files.length === 1 ? 'image' : 'image[]'
  for (const file of files) form.append(imageField, file, file.name)
  if (mask) form.append('mask', mask, mask.name)

  return { ok: true, model, form }
}
