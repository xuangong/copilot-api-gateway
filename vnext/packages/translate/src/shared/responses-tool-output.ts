import { TranslatorValidationError } from "../errors.ts"

export interface ResponsesToolOutput {
  type: "function_call_output" | "custom_tool_call_output"
  call_id: string
  output?: unknown
  status?: string
}

type TextPart = { type: "text"; text: string }
type ImageSource = { type: "base64"; media_type: string; data: string } | { type: "url"; url: string }
type ImagePart = { type: "image"; url: string; detail?: "auto" | "low" | "high"; source: ImageSource }
type OutputPart = TextPart | ImagePart

function invalidOutput(message: string): never {
  throw new TranslatorValidationError(message, "input.output")
}

function outputParts(item: ResponsesToolOutput): string | OutputPart[] {
  if (typeof item.call_id !== "string" || !item.call_id) invalidOutput("Tool output requires a call_id")
  if (item.output === undefined) return ""
  if (typeof item.output === "string") return item.output
  if (!Array.isArray(item.output)) invalidOutput("Tool output must be a string or content array")
  return item.output.map((value: unknown): OutputPart => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidOutput("Cannot translate malformed tool output content")
    const part = value as Record<string, unknown>
    if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      return { type: "text", text: part.text }
    }
    if (part.type !== "input_image") invalidOutput("Cannot translate unsupported tool output content")
    if (typeof part.image_url !== "string" || !part.image_url) invalidOutput("Tool output image requires an available image_url")
    const url = part.image_url
    let source: ImageSource
    if (url.startsWith("data:")) {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url)
      const mediaType = match?.[1]
      const data = match?.[2]
      if (!mediaType || !data) invalidOutput("Cannot translate unavailable or unsupported tool output image")
      source = { type: "base64", media_type: mediaType, data }
    } else {
      let parsed: URL
      try { parsed = new URL(url) } catch { invalidOutput("Tool output image must have an absolute URL") }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") invalidOutput("Cannot translate unsupported tool output image URL")
      source = { type: "url", url }
    }
    if (part.detail !== undefined && part.detail !== "auto" && part.detail !== "low" && part.detail !== "high") {
      invalidOutput("Cannot translate unsupported tool output image detail")
    }
    return { type: "image", url, source, ...(part.detail !== undefined ? { detail: part.detail } : {}) }
  })
}

export type ChatToolImagePart = TextPart | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }

export function projectChatToolOutput(item: ResponsesToolOutput): { content: string; images: ChatToolImagePart[] } {
  const parts = outputParts(item)
  if (typeof parts === "string") return { content: parts, images: [] }
  const images: ChatToolImagePart[] = []
  for (const part of parts) {
    if (part.type === "image") images.push({ type: "image_url", image_url: { url: part.url, ...(part.detail !== undefined ? { detail: part.detail } : {}) } })
  }
  const text = parts.flatMap(part => part.type === "text" ? [part.text] : []).join("")
  if (images.length === 0) return { content: text, images }
  return {
    content: text || "Image output is attached in the following user message.",
    images: [{ type: "text", text: `Image output from tool call ${item.call_id}:` }, ...images],
  }
}

export function projectMessagesToolOutput(item: ResponsesToolOutput): string | Array<TextPart | { type: "image"; source: ImageSource }> {
  const parts = outputParts(item)
  if (typeof parts === "string") return parts
  return parts.length === 0 ? "" : parts.map(part => part.type === "text" ? part : { type: "image", source: part.source })
}
