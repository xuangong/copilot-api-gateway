import type { Invocation, RequestContext } from "@vibe-llm/protocols/common"
import type { MessagesStreamEvent } from "@vibe-llm/protocols/messages"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const instruction = "You must call the web_search tool for the user's query before completing this response. Do not answer from memory or return a text-only response."

/** The native hosted-search shim remains responsible for executing the tool. */
export function prepareLokiForcedSearch(invocation: Invocation, ctx: RequestContext, original: Record<string, unknown>): boolean {
  if ((invocation.sourceApi ?? "messages") !== "messages") return false
  if (ctx.upstreamKind !== "loki" || original.model !== "claude-opus-5.5") return false
  const choice = record(original.tool_choice)
  if (choice.type !== "tool" || choice.name !== "web_search") return false
  const tools = original.tools
  if (!Array.isArray(tools) || tools.length !== 1) return false
  const tool = record(tools[0])
  if (!["web_search_20250305", "web_search_20260209", "web_search_20260318"].includes(String(tool.type))) return false

  const system = invocation.payload.system
  if (system !== undefined && typeof system !== "string" && !Array.isArray(system)) return false
  const { name: _name, ...rest } = choice
  invocation.payload = { ...invocation.payload, tool_choice: { ...rest, type: "auto" },
    system: Array.isArray(system) ? [...system, { type: "text", text: instruction }]
      : typeof system === "string" ? `${system}\n\n${instruction}` : instruction }
  return true
}

const missingSearch = () => eventFrame<MessagesStreamEvent>({ type: "error", error: {
  type: "api_error", message: "Loki did not produce the required web_search call. No search result was returned.",
} })

/** Buffer the prelude until a real tool call proves the forced-search contract.
 * Pings can pass through, but an unsearched text answer can never look successful.
 */
export async function* requireLokiSearchCall(frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>, abort?: () => void): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  const pending: ProtocolFrame<MessagesStreamEvent>[] = []
  let bytes = 0
  let verified = false
  let lastPing = 0
  for await (const frame of frames) {
    if (verified) { yield frame; continue }
    if (frame.type === "event" && (frame.event.type === "error" || frame.event.type === "ping")) {
      yield frame
      if (frame.event.type === "error") return
      lastPing = Date.now()
      continue
    }
    if (Date.now() - lastPing >= 5000) {
      yield eventFrame<MessagesStreamEvent>({ type: "ping" })
      lastPing = Date.now()
    }
    bytes += new TextEncoder().encode(JSON.stringify(frame)).byteLength
    if (bytes > 256 * 1024) { abort?.(); yield missingSearch(); return }
    pending.push(frame)
    if (frame.type === "event" && frame.event.type === "content_block_start"
      && frame.event.content_block.type === "tool_use" && frame.event.content_block.name === "web_search") {
      verified = true
      yield* pending
      pending.length = 0
    }
  }
  if (!verified) yield missingSearch()
}
