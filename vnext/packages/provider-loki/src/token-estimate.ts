// Loki has no count_tokens endpoint and hides Anthropic's token counts in its
// errors, so overflow detection needs a local estimate. The rates were fitted
// against Claude Code transcripts on the Claude 5 tokenizer: code, logs and
// JSON tool results average ~2.6 characters per token (5th-95th percentile
// 2.1-3.1), CJK text ~1.3 tokens per character, and a retained thinking block
// costs about one token per 6 characters of its signature.
const ASCII_CHARS_PER_TOKEN = 2.6
const NON_ASCII_TOKENS_PER_CHAR = 1.3
const SIGNATURE_CHARS_PER_TOKEN = 6
// High-resolution vision: 2576px long edge, 3.75MP and 4784 tokens per image.
const IMAGE_MAX_EDGE = 2_576
const IMAGE_MAX_PIXELS = 3_750_000
const IMAGE_MAX_TOKENS = 4_784
// Unknown image formats, remote images and binary documents get the older
// per-image cap: an undercount, never a reason to call a request oversized.
const MEDIA_FALLBACK_TOKENS = 1_600
// JPEG frame headers follow the APP segments; 64 KiB covers EXIF thumbnails.
const IMAGE_HEADER_BASE64_CHARS = 87_384

type Counter = { ascii: number; nonAscii: number; fixed: number }
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

function text(counter: Counter, value: unknown): void {
  if (typeof value !== "string") return
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 128) counter.ascii++
    // A surrogate pair is one character, not two.
    else if (code < 0xdc00 || code > 0xdfff) counter.nonAscii++
  }
}

function imageSize(data: string): { width: number; height: number } | undefined {
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(data.slice(0, IMAGE_HEADER_BASE64_CHARS)), char => char.charCodeAt(0))
  } catch {
    return undefined
  }
  const u16 = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!
  const u32 = (at: number) => u16(at) * 65_536 + u16(at + 2)
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: u32(16), height: u32(20) }
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  for (let at = 2; at + 9 < bytes.length && bytes[at] === 0xff;) {
    const marker = bytes[at + 1]!
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: u16(at + 7), height: u16(at + 5) }
    }
    at += marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) ? 2 : 2 + u16(at + 2)
  }
  return undefined
}

function imageTokens(block: Record<string, unknown>): number {
  const source = record(block.source)
  const size = source.type === "base64" && typeof source.data === "string" ? imageSize(source.data) : undefined
  if (!size?.width || !size.height) return MEDIA_FALLBACK_TOKENS
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(size.width, size.height),
    Math.sqrt(IMAGE_MAX_PIXELS / (size.width * size.height)))
  return Math.min(IMAGE_MAX_TOKENS, Math.ceil(size.width * size.height * scale * scale / 750))
}

function content(counter: Counter, value: unknown): void {
  if (typeof value === "string") return text(counter, value)
  if (!Array.isArray(value)) return
  for (const item of value) {
    const block = record(item)
    switch (block.type) {
      case undefined: break
      case "text": text(counter, block.text); break
      case "image": counter.fixed += imageTokens(block); break
      case "document": {
        const source = record(block.source)
        if (source.type === "text") text(counter, source.data)
        else if (source.type === "content") content(counter, source.content)
        else counter.fixed += MEDIA_FALLBACK_TOKENS
        break
      }
      case "thinking":
        if (typeof block.signature === "string" && block.signature) counter.fixed += Math.ceil(block.signature.length / SIGNATURE_CHARS_PER_TOKEN)
        else text(counter, block.thinking)
        break
      case "redacted_thinking":
        if (typeof block.data === "string") counter.fixed += Math.ceil(block.data.length / SIGNATURE_CHARS_PER_TOKEN)
        break
      case "tool_use": case "server_tool_use":
        text(counter, block.name)
        text(counter, JSON.stringify(block.input ?? {}))
        break
      case "tool_result":
        content(counter, block.content)
        break
      default:
        text(counter, JSON.stringify(block))
    }
  }
}

/** Approximate prompt tokens of an Anthropic Messages request. */
export function estimateMessagesInputTokens(payload: Record<string, unknown>): number {
  const counter: Counter = { ascii: 0, nonAscii: 0, fixed: 0 }
  content(counter, payload.system)
  if (Array.isArray(payload.tools)) for (const tool of payload.tools) text(counter, JSON.stringify(tool))
  if (Array.isArray(payload.messages)) for (const message of payload.messages) content(counter, record(message).content)
  return Math.ceil(counter.ascii / ASCII_CHARS_PER_TOKEN + counter.nonAscii * NON_ASCII_TOKENS_PER_CHAR) + counter.fixed
}
