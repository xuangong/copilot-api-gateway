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

/** `undefined` means "not known yet" — see `playgroundMode`. */
export type PlaygroundMode = "chat" | "image"

/**
 * Which endpoints the selected model uses.
 *
 * Deliberately `undefined` until the model list has loaded and the model is in
 * it. Defaulting to `chat` in that window sent an image model down the chat
 * path on the first send after a reload, and the upstream answered "No messages
 * upstream available for model: gpt-image-2".
 */
export function playgroundMode(
  capabilities: { type?: string } | undefined,
  modelsLoaded: boolean,
): PlaygroundMode | undefined {
  if (!modelsLoaded || !capabilities) return undefined
  return capabilities.type === "image" ? "image" : "chat"
}

/** The subset of a chat message this module needs. */
interface ImageTurn {
  role: "user" | "assistant"
  text: string
  parts?: Part[]
}

/**
 * Folds the conversation into the one prompt + reference images an image
 * request can carry.
 *
 * `/v1/images/*` has no messages array — each call sees only what it is given.
 * Sending just the latest line means a follow-up like "continue" arrives with
 * no subject at all, which is how a poster request came back as unrelated
 * artwork. So the reference image comes from the thread when the composer has
 * none, and every prior instruction rides along with the new one.
 */
export function buildImageContext(history: ImageTurn[], maxTurns = 8): {
  prompt: string
  refs: Part[]
} {
  // Scanning backwards puts the composer's own images first when it has any,
  // then the newest result — which is what a bare "continue" refers to.
  let refs: Part[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    const images = (history[i]!.parts ?? []).filter((p) => p.type === "image" && p.dataUrl)
    if (images.length > 0) {
      refs = images
      break
    }
  }

  const instructions = history
    .filter((m) => m.role === "user")
    .map((m) => m.text.trim())
    .filter((t) => t !== "")
    // "continue, continue, continue" is one intent, not three.
    .filter((t, i, all) => t !== all[i - 1])
    .slice(-maxTurns)

  const latest = instructions[instructions.length - 1] ?? ""
  const earlier = instructions.slice(0, -1)
  if (earlier.length === 0) return { prompt: latest, refs }

  // Labelled rather than concatenated: a flat join reads as a list of commands,
  // so the model re-executes "make a poster" on every follow-up instead of
  // treating it as the background to "continue".
  return {
    prompt:
      `Earlier instructions in this session, for context:\n${earlier.join("\n")}` +
      `\n\nWhat to do now:\n${latest}`,
    refs,
  }
}
