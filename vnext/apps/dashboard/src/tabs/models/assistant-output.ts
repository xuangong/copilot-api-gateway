/**
 * A reply as the protocol that produced it, kept beside the visible text so
 * the next turn can replay what that text drops: Messages thinking blocks and
 * their signatures, Chat Completions `reasoning_text` / `reasoning_opaque`,
 * Gemini thought parts and their `thoughtSignature`. Reduced to text, every
 * reasoning-enabled follow-up starts its reasoning over. A thread that switches
 * protocol replays the turn as text, since one protocol's reasoning state has
 * no place in another's request shape.
 */
export type Protocol = "openai" | "anthropic" | "gemini"

export type AssistantOutput =
  | { protocol: "openai"; message: Record<string, unknown> }
  | { protocol: "anthropic"; content: unknown[] }
  | { protocol: "gemini"; parts: Record<string, unknown>[] }

/** The turn as `protocol` takes it back, or undefined to replay it as text. */
export function replayTurn(turn: { role: string; output?: AssistantOutput }, protocol: Protocol): Record<string, unknown> | undefined {
  const output = turn.role === "assistant" ? turn.output : undefined
  if (output?.protocol !== protocol) return undefined
  if (output.protocol === "openai") return { ...output.message, role: "assistant" }
  if (output.protocol === "anthropic") return { role: "assistant", content: output.content }
  return { role: "model", parts: output.parts }
}

/**
 * Rebuilds a Chat Completions assistant message from its deltas the way the
 * gateway's own reassembler does: text and reasoning concatenate (an opaque
 * signature can arrive in pieces), reasoning items append.
 */
export class ChatCompletionsReply {
  private content = ""
  private reasoningText: string | undefined
  private reasoningOpaque: string | undefined
  private readonly reasoningItems: unknown[] = []

  add(delta: Record<string, unknown>): void {
    if (typeof delta.content === "string") this.content += delta.content
    const reasoning = [delta.reasoning_text, delta.reasoning_content, delta.reasoning].find((value) => typeof value === "string")
    if (typeof reasoning === "string") this.reasoningText = (this.reasoningText ?? "") + reasoning
    if (typeof delta.reasoning_opaque === "string") this.reasoningOpaque = (this.reasoningOpaque ?? "") + delta.reasoning_opaque
    if (Array.isArray(delta.reasoning_items)) this.reasoningItems.push(...(delta.reasoning_items as unknown[]))
  }

  output(): AssistantOutput | undefined {
    if (!this.content && this.reasoningText === undefined && this.reasoningOpaque === undefined && this.reasoningItems.length === 0) return undefined
    return { protocol: "openai", message: {
      role: "assistant",
      content: this.content,
      ...(this.reasoningText !== undefined ? { reasoning_text: this.reasoningText } : {}),
      ...(this.reasoningOpaque !== undefined ? { reasoning_opaque: this.reasoningOpaque } : {}),
      ...(this.reasoningItems.length > 0 ? { reasoning_items: this.reasoningItems } : {}),
    } }
  }
}

/**
 * Thought parts arrive whole and replay as they came — the gateway's Gemini
 * translators accept a signature only on a thought part. The reply text
 * streams in fragments and is merged back into one part after them.
 */
export function geminiReply(parts: readonly Record<string, unknown>[]): AssistantOutput | undefined {
  const thoughts = parts.filter((part) => part.thought === true)
  const text = parts.flatMap((part) => (part.thought !== true && typeof part.text === "string" ? [part.text] : [])).join("")
  const replay = [...thoughts, ...(text ? [{ text }] : [])]
  return replay.length > 0 ? { protocol: "gemini", parts: replay } : undefined
}
