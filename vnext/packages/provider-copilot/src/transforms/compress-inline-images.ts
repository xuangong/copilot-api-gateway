/**
 * Recompress inline base64 image content (`data:image/*;base64,...`) in
 * outgoing payloads to WebP via the registered ImageProcessor before the
 * upstream call. Remote https image references are forwarded as-is.
 *
 * Three protocol shapes, three entry points sharing one inline helper:
 *
 *   - Messages: Anthropic `image` blocks at top-level message.content and
 *     nested inside `tool_result.content[]`. Carries base64 data in
 *     `source.data` with `source.media_type` — the recompressed pixels need
 *     both updated, and `source.type` stays "base64".
 *   - Chat Completions: OpenAI `image_url` content parts. The base64 data
 *     lives inside `image_url.url` as a full data URL.
 *   - Responses: `input_image` parts inside message.content and inside
 *     `function_call_output` outputs (multimodal tool results, e.g. a
 *     screenshot tool). Base64 lives in `image_url` as a full data URL.
 *
 * Per-model size caps are inlined here so the calculator knows the exact
 * downscale point of each upstream encoder and we never ship pixels the
 * model would discard server-side. Caps measured on the real generation
 * path (count_tokens misreports the Claude downscale).
 *
 * Adapted from copilot-gateway:
 * apps/api/src/data-plane/providers/copilot/interceptors/{messages,chat-completions,responses}/compress-images.ts
 * apps/api/src/data-plane/providers/copilot/interceptors/image-size.ts
 */

import {
  compressBase64ImageToWebp,
  compressImageDataUrlToWebp,
  fitWithin,
  isBase64ImageDataUrl,
  type ImageSizeCalculator,
  type SizeCaps,
} from "../image"

import type {
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  ResponsesPayload,
} from "./types"

// ── Per-model size caps ────────────────────────────────────────────────
// Claude (Messages egress): Opus 4.7 was the first high-res Claude model;
// Opus 4.7+ sample up to ~3.59 MP within 2576px. Earlier Opus and the
// Sonnet/Haiku families clamp to ~1.18 MP / 1568px.
const STANDARD_CLAUDE_CAPS: SizeCaps = { maxLongEdge: 1568, maxArea: 1_176_000 }

const claudeImageCaps = (upstreamModelId: string): SizeCaps => {
  const opus = /opus-(\d+)(?:\.(\d+))?/.exec(upstreamModelId)
  if (!opus) return STANDARD_CLAUDE_CAPS
  const major = Number(opus[1])
  const minor = opus[2] === undefined ? 0 : Number(opus[2])
  const highRes = major > 4 || (major === 4 && minor >= 7)
  return highRes ? { maxLongEdge: 2576, maxArea: 3_588_000 } : STANDARD_CLAUDE_CAPS
}

// Copilot Responses/Chat egress: caps measured at the model's server-side
// downscale point so the calculator reproduces what the upstream would do.
//   - gpt-4o / gpt-4.1 (non-mini/nano): tile encoder, 2048×768 box.
//   - gpt-5-mini: patch encoder, still 768 short-edge clamp.
//   - gpt-5.x / fallback: patch encoder, ~2.56 MP within 2048px box.
//   - gemini: clamp long edge to 2048 (no documented sampling cap).
// Unknown models fall back to the most permissive cap so we never
// over-shrink an image a model might use at full detail.
const responsesChatCaps = (upstreamModelId: string): SizeCaps => {
  if (upstreamModelId.startsWith("gemini")) return { maxLongEdge: 2048 }
  if (upstreamModelId.startsWith("gpt-4o") || /^gpt-4\.1(?!-?(?:mini|nano))/.test(upstreamModelId)) {
    return { maxLongEdge: 2048, maxShortEdge: 768 }
  }
  if (upstreamModelId.startsWith("gpt-5-mini")) return { maxLongEdge: 2048, maxShortEdge: 768 }
  return { maxLongEdge: 2048, maxArea: 2_560_000 }
}

const claudeTargetSize = (upstreamModelId: string): ImageSizeCalculator => {
  const caps = claudeImageCaps(upstreamModelId)
  return (source) => fitWithin(source, caps)
}

const responsesChatTargetSize = (upstreamModelId: string): ImageSizeCalculator => {
  const caps = responsesChatCaps(upstreamModelId)
  return (source) => fitWithin(source, caps)
}

// ── Anthropic Messages ─────────────────────────────────────────────────
const collectAnthropicImageBlocks = (messages: AnthropicMessage[]): AnthropicImageBlock[] => {
  const blocks: AnthropicImageBlock[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === "image") {
        blocks.push(block)
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if ((inner as { type?: string }).type === "image") {
            blocks.push(inner as AnthropicImageBlock)
          }
        }
      }
    }
  }
  return blocks
}

export const compressInlineImagesMessages = async (
  payload: AnthropicMessagesPayload,
  upstreamModelId: string,
): Promise<number> => {
  const blocks = collectAnthropicImageBlocks(payload.messages).filter(
    (b) => b.source.type === "base64" && typeof b.source.data === "string",
  )
  if (blocks.length === 0) return 0
  const targetSize = claudeTargetSize(upstreamModelId)
  await Promise.all(
    blocks.map(async (block) => {
      const { data, converted } = await compressBase64ImageToWebp(block.source.data as string, targetSize)
      block.source.data = data
      if (converted) block.source.media_type = "image/webp"
    }),
  )
  return blocks.length
}

// ── Chat Completions ───────────────────────────────────────────────────
interface ChatImageUrlPart {
  type: "image_url"
  image_url: { url: string }
}
interface ChatMessageContent {
  content?: unknown
}
interface ChatCompletionsLikePayload {
  messages?: ChatMessageContent[]
}

const isChatImageUrlPart = (part: unknown): part is ChatImageUrlPart => {
  if (!part || typeof part !== "object") return false
  const p = part as { type?: unknown; image_url?: { url?: unknown } }
  return p.type === "image_url" && typeof p.image_url?.url === "string"
}

export const compressInlineImagesChatCompletions = async (
  payload: ChatCompletionsLikePayload,
  upstreamModelId: string,
): Promise<number> => {
  if (!Array.isArray(payload.messages)) return 0
  const targets: ChatImageUrlPart["image_url"][] = []
  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (isChatImageUrlPart(part) && isBase64ImageDataUrl(part.image_url.url)) {
        targets.push(part.image_url)
      }
    }
  }
  if (targets.length === 0) return 0
  const targetSize = responsesChatTargetSize(upstreamModelId)
  await Promise.all(
    targets.map(async (target) => {
      target.url = await compressImageDataUrlToWebp(target.url, targetSize)
    }),
  )
  return targets.length
}

// ── Responses ──────────────────────────────────────────────────────────
interface ResponseInputImagePart {
  type: "input_image"
  image_url: string
}

const isResponseInputImage = (part: unknown): part is ResponseInputImagePart => {
  if (!part || typeof part !== "object") return false
  const p = part as { type?: unknown; image_url?: unknown }
  return p.type === "input_image" && typeof p.image_url === "string"
}

export const compressInlineImagesResponses = async (
  payload: ResponsesPayload,
  upstreamModelId: string,
): Promise<number> => {
  if (!Array.isArray(payload.input)) return 0
  const targets: ResponseInputImagePart[] = []
  for (const item of payload.input) {
    // Image parts can live under `content` on message items and under
    // `output` on function_call_output items (multimodal tool results,
    // e.g. a screenshot returned from a custom tool).
    const t = (item as { type?: string }).type
    let parts: unknown
    if (t === "message") parts = (item as { content?: unknown }).content
    else if (t === "function_call_output") parts = (item as { output?: unknown }).output
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (isResponseInputImage(part) && isBase64ImageDataUrl(part.image_url)) {
        targets.push(part)
      }
    }
  }
  if (targets.length === 0) return 0
  const targetSize = responsesChatTargetSize(upstreamModelId)
  await Promise.all(
    targets.map(async (target) => {
      target.image_url = await compressImageDataUrlToWebp(target.image_url, targetSize)
    }),
  )
  return targets.length
}
