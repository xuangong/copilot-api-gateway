/**
 * The send pipeline: one function per wire protocol, plus the image endpoints
 * and the token count. Each takes the request settings as plain values and
 * reports what the stream yields through `ChatSink`, so the panel decides how
 * the thread changes and these only speak HTTP.
 *
 * Web search is requested through each protocol's *hosted* search shape, not
 * as a client function tool. The playground is an ordinary client: the gateway
 * runs the search server-side (where the search credentials live — they must
 * never reach the browser) and the tool schema the model sees is the gateway's
 * business, not ours. Declaring a `web_search` function tool here would mean
 * claiming we execute it, which we can't.
 */
import {
  buildEditsForm, buildGenerationsBody, buildImageContext, imagesErrorMessage,
  parseImagesResponse, type ImageParams,
} from "../images"
import { putImage } from "../image-store"
import type { Part } from "../parts"
import { toAnthropicContent, toChatHistory, toGeminiParts, toOpenAIContent } from "../payload"
import { replayTurn, type AssistantOutput } from "../assistant-output"
import type { BrowserPerformance } from "../browser-performance"
import { parseOpenAIStream, type Citation, type StreamUsage, type WebSearchProgress } from "../streams/openai"
import { parseAnthropicStream } from "../streams/anthropic"
import { parseGeminiStream } from "../streams/gemini"
import { composeSystemPrompt, type Message } from "./chat-state"

/**
 * How many `pause_turn` continuations the playground will drive before giving
 * up. The gateway already caps how many searches one turn may run; this only
 * stops a pathological ping-pong from looping forever in the browser.
 */
const MAX_PAUSE_TURNS = 8

/** What one send needs to know, captured when the send starts. */
export interface SendSettings {
  modelId: string
  apiKey: string
  systemPrompt: string
  webSearchEnabled: boolean
  imageParams: ImageParams
  t: (key: string, vars?: Record<string, string | number>) => string
}

/** Where a streaming reply lands: each call updates the trailing assistant turn. */
export interface ChatSink {
  appendText(chunk: string): void
  setUsage(usage: StreamUsage): void
  setOutput(output: AssistantOutput): void
  webSearch(progress: WebSearchProgress): void
  citations(citations: Citation[]): void
  setImages(parts: Part[], usage: StreamUsage | undefined): void
}

export function toAnthropicMessages(history: Message[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const turn of toChatHistory(history)) {
    const replay = replayTurn(turn, "anthropic")
    if (replay) { out.push(replay); continue }
    const content = toAnthropicContent(turn.parts, turn.role)
    if (typeof content === "string" && !content) continue
    out.push({ role: turn.role, content })
  }
  return out
}

/**
 * The thread's exact upstream token cost from /v1/messages/count_tokens —
 * what billing and limits will see. Undefined when the count isn't available.
 */
export async function countContextTokens(
  history: Message[],
  settings: Pick<SendSettings, "modelId" | "apiKey" | "systemPrompt">,
  signal: AbortSignal,
): Promise<number | undefined> {
  const { modelId, apiKey, systemPrompt } = settings
  const anMessages = toAnthropicMessages(history)
  const body: Record<string, unknown> = { model: modelId, messages: anMessages }
  body.system = composeSystemPrompt(systemPrompt)
  try {
    const resp = await fetch("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(body),
      signal,
    })
    if (!resp.ok) return undefined
    const j = await resp.json() as { input_tokens?: number }
    if (typeof j.input_tokens === "number") return j.input_tokens
  } catch {
    /* aborted or network error — leave previous value */
  }
  return undefined
}

/**
 * Image models take a prompt, not a conversation. References pasted into the
 * composer turn the call into an edit — same one funnel, so a screenshot you
 * paste is the image you edit.
 */
export async function sendImages(history: Message[], signal: AbortSignal, settings: SendSettings, sink: ChatSink) {
  const { modelId, apiKey, imageParams } = settings
  const { prompt, refs } = buildImageContext(history)
  const editing = refs.length > 0

  const resp = editing
    ? await fetch("/v1/images/edits", {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: buildEditsForm(modelId, prompt, imageParams, refs),
        signal,
      })
    : await fetch("/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(buildGenerationsBody(modelId, prompt, imageParams)),
        signal,
      })

  const text = await resp.text()
  if (!resp.ok) throw new Error(imagesErrorMessage(text) || `HTTP ${resp.status}`)

  const { parts: result, usage } = parseImagesResponse(JSON.parse(text))
  // Store the bytes the same way pasted images are stored, so a reload
  // rehydrates generated images from IndexedDB instead of a placeholder.
  const stored: Part[] = []
  for (const p of result) {
    if (p.type !== "image") continue
    stored.push(p.dataUrl.startsWith("data:")
      ? { type: "image", dataUrl: p.dataUrl, id: await putImage(p.dataUrl) }
      : p)
  }
  sink.setImages(stored, usage)
}

export async function sendOpenAI(history: Message[], signal: AbortSignal, observation: BrowserPerformance, settings: SendSettings, sink: ChatSink) {
  const { modelId, apiKey, systemPrompt, webSearchEnabled } = settings
  observation.beginResponse("chat_completions")
  const oaiMessages: Array<Record<string, unknown>> = []
  oaiMessages.push({ role: "system", content: composeSystemPrompt(systemPrompt) })
  for (const turn of toChatHistory(history)) {
    const replay = replayTurn(turn, "openai")
    if (replay) { oaiMessages.push(replay); continue }
    const content = toOpenAIContent(turn.parts, turn.role)
    if (typeof content === "string" && !content) continue
    oaiMessages.push({ role: turn.role, content })
  }
  const resp = await fetch("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      model: modelId,
      messages: oaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...(webSearchEnabled ? { web_search_options: {} } : {}),
    }),
    signal,
  })
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => "")
    throw new Error(errText || `HTTP ${resp.status}`)
  }
  if (resp.headers.get("x-gateway-stream-timing") === "unavailable") observation.unavailableStreamingTiming()
  for await (const ch of parseOpenAIStream(resp.body, observation.observe)) {
    signal.throwIfAborted()
    if (ch.type === "delta") {
      sink.appendText(ch.text)
      await new Promise<void>((r) => setTimeout(r, 0))
    } else if (ch.type === "web_search") sink.webSearch(ch.progress)
    else if (ch.type === "citations") sink.citations(ch.citations)
    else if (ch.type === "output") sink.setOutput(ch.output)
    else sink.setUsage(ch.usage)
  }
}

export async function sendAnthropic(history: Message[], signal: AbortSignal, observation: BrowserPerformance, settings: SendSettings, sink: ChatSink) {
  const { modelId, systemPrompt, webSearchEnabled, t } = settings
  const anMessages = toAnthropicMessages(history)
  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: 4096,
    messages: anMessages,
    stream: true,
  }
  body.system = composeSystemPrompt(systemPrompt)
  if (webSearchEnabled) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }]
  }

  // A hosted search ends the turn with `pause_turn` and no answer text: the
  // gateway ran the search, and the client owns the decision to continue.
  // Replay the assistant blocks verbatim until the model actually answers.
  // Continuations extend the same assistant turn, so the reply kept for
  // replay is every paused block followed by the final ones.
  const continued: unknown[] = []
  for (let turn = 0; turn < MAX_PAUSE_TURNS; turn++) {
    const paused = await streamAnthropicTurn(body, signal, observation, continued, settings, sink)
    if (!paused) return
    anMessages.push({ role: "assistant", content: paused })
    continued.push(...paused)
  }
  throw new Error(t("dash.playground.continuationLimit"))
}

/** One `/v1/messages` round trip. Returns the assistant blocks if it paused. */
async function streamAnthropicTurn(
  body: Record<string, unknown>,
  signal: AbortSignal,
  observation: BrowserPerformance,
  continued: readonly unknown[],
  settings: SendSettings,
  sink: ChatSink,
): Promise<unknown[] | null> {
  const { apiKey } = settings
  observation.beginResponse("messages")
  const resp = await fetch("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => "")
    throw new Error(errText || `HTTP ${resp.status}`)
  }
  if (resp.headers.get("x-gateway-stream-timing") === "unavailable") observation.unavailableStreamingTiming()
  for await (const ch of parseAnthropicStream(resp.body, observation.observe)) {
    signal.throwIfAborted()
    if (ch.type === "delta") {
      sink.appendText(ch.text)
      await new Promise<void>((r) => setTimeout(r, 0))
    } else if (ch.type === "usage") sink.setUsage(ch.usage)
    else if (ch.type === "web_search") sink.webSearch(ch.progress)
    else if (ch.type === "citations") sink.citations(ch.citations)
    else if (ch.type === "pause_turn") return ch.content
    else if (ch.type === "output" && ch.output.protocol === "anthropic") sink.setOutput({ protocol: "anthropic", content: [...continued, ...ch.output.content] })
  }
  return null
}

export async function sendGemini(history: Message[], signal: AbortSignal, observation: BrowserPerformance, settings: SendSettings, sink: ChatSink) {
  const { modelId, apiKey, systemPrompt, webSearchEnabled } = settings
  observation.beginResponse("gemini")
  const contents: Array<Record<string, unknown>> = []
  for (const turn of toChatHistory(history)) {
    const replay = replayTurn(turn, "gemini")
    if (replay) { contents.push(replay); continue }
    const parts = toGeminiParts(turn.parts, turn.role)
    if (parts.length === 0) continue
    contents.push({ role: turn.role === "assistant" ? "model" : "user", parts })
  }
  const body: Record<string, unknown> = { contents }
  body.systemInstruction = { parts: [{ text: composeSystemPrompt(systemPrompt) }] }
  if (webSearchEnabled) {
    body.tools = [{ googleSearch: {} }]
  }
  const resp = await fetch(
    `/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal,
    },
  )
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => "")
    throw new Error(errText || `HTTP ${resp.status}`)
  }
  if (resp.headers.get("x-gateway-stream-timing") === "unavailable") observation.unavailableStreamingTiming()
  for await (const ch of parseGeminiStream(resp.body, observation.observe)) {
    signal.throwIfAborted()
    if (ch.type === "delta") {
      sink.appendText(ch.text)
      await new Promise<void>((r) => setTimeout(r, 0))
    } else if (ch.type === "usage") sink.setUsage(ch.usage)
    else if (ch.type === "web_search") sink.webSearch(ch.progress)
    else if (ch.type === "citations") sink.citations(ch.citations)
    else if (ch.type === "output") sink.setOutput(ch.output)
  }
}
