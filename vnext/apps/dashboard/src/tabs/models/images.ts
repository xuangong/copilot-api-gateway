/**
 * The `/v1/images/*` side of the playground.
 *
 * Image models don't speak any of the three chat protocols — they take a
 * prompt and hand back bytes. Request shaping and response parsing live here
 * as pure functions, the same split `payload.ts` uses for chat, so the wire
 * shapes are testable without a browser or an upstream.
 */

import { type Part, splitDataUrl } from "./parts"
import type { StreamUsage } from "./streams/openai"

export interface ImageParams {
  size: string
  quality: string
  n: number
  background: string
  outputFormat: string
  /** Edits only — how closely the result must track the reference image. */
  inputFidelity: string
}

/**
 * `auto` means "let the upstream decide" and is dropped from the request, so
 * the defaults here are the do-nothing ones. `n: 1` is sent explicitly: it
 * costs nothing and doesn't rely on the upstream's default matching ours.
 */
export const DEFAULT_IMAGE_PARAMS: ImageParams = {
  size: "auto",
  quality: "auto",
  n: 1,
  background: "auto",
  outputFormat: "auto",
  inputFidelity: "auto",
}

export const SIZE_OPTIONS = ["auto", "1024x1024", "1024x1536", "1536x1024"] as const
export const QUALITY_OPTIONS = ["auto", "low", "medium", "high"] as const
export const BACKGROUND_OPTIONS = ["auto", "opaque", "transparent"] as const
export const OUTPUT_FORMAT_OPTIONS = ["auto", "png", "jpeg", "webp"] as const
export const INPUT_FIDELITY_OPTIONS = ["auto", "low", "high"] as const

/** Wire names for the params that are just enums, in request order. */
const ENUM_FIELDS: Array<[keyof ImageParams, string]> = [
  ["size", "size"],
  ["quality", "quality"],
  ["background", "background"],
  ["outputFormat", "output_format"],
]

export function buildGenerationsBody(
  model: string,
  prompt: string,
  params: ImageParams,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, prompt, n: params.n }
  for (const [key, wire] of ENUM_FIELDS) {
    const value = params[key]
    if (typeof value === "string" && value !== "auto") body[wire] = value
  }
  return body
}

export function buildEditsForm(
  model: string,
  prompt: string,
  params: ImageParams,
  refs: Part[],
): FormData {
  const form = new FormData()
  form.append("model", model)
  form.append("prompt", prompt)
  form.append("n", String(params.n))
  for (const [key, wire] of ENUM_FIELDS) {
    const value = params[key]
    if (typeof value === "string" && value !== "auto") form.append(wire, value)
  }
  if (params.inputFidelity !== "auto") form.append("input_fidelity", params.inputFidelity)

  // Field naming follows OpenAI's gpt-image contract, same as the gateway's
  // own serializer in provider-llm/src/images.ts.
  const blobs = refs
    .filter((p): p is Extract<Part, { type: "image" }> => p.type === "image")
    .map((p) => dataUrlToBlob(p.dataUrl))
    .filter((b): b is Blob => b !== null)
  const field = blobs.length === 1 ? "image" : "image[]"
  blobs.forEach((blob, i) => form.append(field, blob, `image-${i}.${extensionFor(blob.type)}`))
  return form
}

function extensionFor(mime: string): string {
  return mime.split("/")[1]?.split("+")[0] || "png"
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  const split = splitDataUrl(dataUrl)
  if (!split) return null
  const binary = atob(split.data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: split.mime })
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>
  output_format?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export function parseImagesResponse(json: unknown): { parts: Part[]; usage?: StreamUsage } {
  const body = (json ?? {}) as ImagesResponse
  const mime = `image/${body.output_format || "png"}`
  const parts: Part[] = []
  for (const item of body.data ?? []) {
    if (item.b64_json) parts.push({ type: "image", dataUrl: `data:${mime};base64,${item.b64_json}` })
    else if (item.url) parts.push({ type: "image", dataUrl: item.url })
  }
  if (!body.usage) return { parts }
  const count = (n: number | undefined) => (typeof n === "number" ? n : 0)
  return {
    parts,
    usage: { input_tokens: count(body.usage.input_tokens), output_tokens: count(body.usage.output_tokens) },
  }
}

/**
 * Image errors arrive nested: the gateway forwards the provider's body, and
 * the provider puts the upstream's whole JSON document into its own `message`.
 * Peel until there is nothing left to peel.
 */
export function imagesErrorMessage(raw: string): string {
  let current = raw
  for (let depth = 0; depth < 4; depth++) {
    let parsed: unknown
    try {
      parsed = JSON.parse(current)
    } catch {
      return current
    }
    const message = (parsed as { error?: { message?: unknown } })?.error?.message
    if (typeof message !== "string") return current
    current = message
  }
  return current
}
