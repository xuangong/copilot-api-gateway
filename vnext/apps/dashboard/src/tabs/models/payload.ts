/**
 * Per-protocol serialization of a composer message.
 *
 * Extracted out of `ChatPanel` so the mapping is testable on its own — the
 * ordering guarantee (`text → image → text` as typed) only holds if every
 * protocol walks `Part[]` in sequence rather than appending images at the end.
 */

import { type Part, splitDataUrl } from "./parts"

type Block = Record<string, unknown>

/** Which turn the content belongs to; assistant turns may not carry images. */
export type Turn = "user" | "assistant"

/**
 * Images only travel as data URLs: the composer produces them from the
 * clipboard / file picker, and remote URLs (from pre-`parts` persisted
 * history) can't be forwarded — Gemini has no url shape at all and Anthropic
 * would need to fetch it server-side. Drop them rather than emit a block the
 * upstream will reject.
 *
 * Assistant turns drop images outright: an image model writes its output there,
 * and no chat API accepts an image block from the assistant.
 */
function inlineImages(parts: Part[], turn?: Turn): Part[] {
  if (turn === "assistant") return parts.filter((p) => p.type !== "image")
  return parts.filter((p) => p.type !== "image" || splitDataUrl(p.dataUrl) !== null)
}

function textOnly(parts: Part[]): string | null {
  return parts.every((p) => p.type === "text")
    ? parts.map((p) => (p.type === "text" ? p.text : "")).join("")
    : null
}

export function toOpenAIContent(parts: Part[], turn?: Turn): string | Block[] {
  const usable = inlineImages(parts, turn)
  const flat = textOnly(usable)
  if (flat !== null) return flat
  return usable.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image_url", image_url: { url: p.dataUrl } },
  )
}

export function toAnthropicContent(parts: Part[], turn?: Turn): string | Block[] {
  const usable = inlineImages(parts, turn)
  const flat = textOnly(usable)
  if (flat !== null) return flat
  return usable.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text }
    // Non-null: `inlineImages` already dropped anything that isn't a data URL.
    const { mime, data } = splitDataUrl(p.dataUrl)!
    return { type: "image", source: { type: "base64", media_type: mime, data } }
  })
}

export function toGeminiParts(parts: Part[], turn?: Turn): Block[] {
  return inlineImages(parts, turn).map((p) => {
    if (p.type === "text") return { text: p.text }
    const { mime, data } = splitDataUrl(p.dataUrl)!
    return { inlineData: { mimeType: mime, data } }
  })
}
