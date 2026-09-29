import { assertClientRepresentableResponseEvent } from "@vibe-llm/translate/shared/client-opaque-state"
import { chatReasoningText } from "@vibe-llm/translate/shared/chat-reasoning-text"
import { decodeOpaqueValue } from "@vibe-llm/protocols/common"
import { InvalidAffinityStateError, MAX_AFFINITY_PAYLOAD_BYTES } from "./carrier.ts"
import type { ProtocolFrame } from "@vibe-core/result"
import { stampAffinityItem } from "./analysis.ts"
import type { RequestAffinity } from "./context.ts"
import type { AffinityProtocol } from "./analysis.ts"

function responseOpaqueKeys(item: Record<string, unknown>): string[] {
  if (["program", "program_output"].includes(String(item.type))) return ["encrypted_content", "fingerprint"]
  if (["reasoning", "compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) return ["encrypted_content"]
  return []
}
function stripResponseItem(item: Record<string, unknown>): Record<string, unknown> {
  const keys = responseOpaqueKeys(item)
  const copy = Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)))
  if (item.type === "agent_message" && Array.isArray(item.content)) copy.content = item.content.map(block => {
    if (!object(block) || block.type !== "encrypted_content") return block
    const { encrypted_content: _opaque, ...rest } = block
    return rest
  })
  return copy
}
function stripOpaque(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type === "response.output_item.added" && object(event.item)) return { ...event, item: stripResponseItem(event.item) }
  if (["response.created", "response.in_progress"].includes(String(event.type)) && object(event.response) && Array.isArray(event.response.output)) {
    return { ...event, response: { ...event.response, output: event.response.output.map(item => object(item) ? stripResponseItem(item) : item) } }
  }
  return event
}
function hasOpaque(item: Record<string, unknown>): boolean {
  return responseOpaqueKeys(item).some(key => typeof item[key] === "string")
    || (item.type === "agent_message" && Array.isArray(item.content) && item.content.some(block => object(block) && block.type === "encrypted_content" && typeof block.encrypted_content === "string"))
}
function itemKey(item: Record<string, unknown>, index: number): string {
  return typeof item.id === "string" && item.id ? `id:${item.id}` : `index:${index}`
}
function boundedBlock(block: { thinking: string; signature: string }): void {
  if (block.signature.length > MAX_AFFINITY_PAYLOAD_BYTES
    || new TextEncoder().encode(JSON.stringify({ thinking: block.thinking })).length > MAX_AFFINITY_PAYLOAD_BYTES) throw new InvalidAffinityStateError()
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
// Run before translators and JSON reassemblers, which may otherwise hide an
// unbounded signature/companion buffer. Throwing closes the upstream iterator.
export async function* guardAffinityFrames<T>(frames: AsyncIterable<ProtocolFrame<T>>, affinity: RequestAffinity | undefined): AsyncGenerator<ProtocolFrame<T>> {
  if (!affinity) { yield* frames; return }
  const blocks = new Map<number, { thinking: string; signature: string }>()
  const summaries = new Map<string, string>()
  const chatBlocks = new Map<number, { thinking: string; signature: string }>()
  const checkOpaque = (value: string) => {
    if (value.length > MAX_AFFINITY_PAYLOAD_BYTES || decodeOpaqueValue(value).bytes.length > MAX_AFFINITY_PAYLOAD_BYTES) throw new InvalidAffinityStateError()
  }
  const checkCompanion = (value: unknown): void => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_AFFINITY_PAYLOAD_BYTES) throw new InvalidAffinityStateError()
  }
  const checkResponseItem = (value: unknown): void => {
    if (!object(value)) return
    const keys = responseOpaqueKeys(value)
    for (const key of keys) if (typeof value[key] === "string") checkOpaque(value[key])
    if (keys.length) checkCompanion(Object.fromEntries(["summary", "content", "code", "result", "call_id"].filter(key => value[key] !== undefined).map(key => [key, value[key]])))
    if (value.type === "agent_message" && Array.isArray(value.content)) {
      for (const block of value.content) if (object(block) && block.type === "encrypted_content" && typeof block.encrypted_content === "string") checkOpaque(block.encrypted_content)
      const visible = stripResponseItem(value)
      checkCompanion({ author: value.author, recipient: value.recipient, agent: value.agent, content: visible.content })
    }
  }
  const checkMessageBlock = (value: unknown): void => {
    if (!object(value)) return
    if (value.type === "thinking") {
      if (typeof value.signature === "string") checkOpaque(value.signature)
      checkCompanion({ thinking: value.thinking })
    }
    if (value.type === "redacted_thinking" && typeof value.data === "string") checkOpaque(value.data)
  }
  for await (const frame of frames) {
    if (frame.type !== "event" || !object(frame.event)) { yield frame; continue }
    const event = frame.event
    if (affinity.protocol === "chat_completions" || affinity.protocol === "gemini") assertClientRepresentableResponseEvent(event)
    if (Array.isArray(event.choices)) for (const choice of event.choices) {
      if (!object(choice) || !object(choice.delta)) continue
      const index = typeof choice.index === "number" ? choice.index : 0
      const value = chatBlocks.get(index) ?? { thinking: "", signature: "" }
      value.thinking += chatReasoningText(choice.delta) ?? ""
      if (typeof choice.delta.reasoning_opaque === "string") value.signature += choice.delta.reasoning_opaque
      boundedBlock(value)
      if (choice.finish_reason != null) { checkOpaque(value.signature); chatBlocks.delete(index) }
      else chatBlocks.set(index, value)
      if (chatBlocks.size > 1024) throw new InvalidAffinityStateError()
    }
    const index = typeof event.index === "number" ? event.index : -1
    if (event.type === "content_block_start" && object(event.content_block) && event.content_block.type === "thinking") {
      const content = event.content_block
      blocks.set(index, { thinking: typeof content.thinking === "string" ? content.thinking : "", signature: typeof content.signature === "string" ? content.signature : "" })
    }
    const block = blocks.get(index)
    if (block && event.type === "content_block_delta" && object(event.delta)) {
      if (event.delta.type === "signature_delta" && typeof event.delta.signature === "string") block.signature += event.delta.signature
      if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") block.thinking += event.delta.thinking
    }
    if (block) {
      boundedBlock(block)
      // Base64 validity can change as fragments arrive; enforce decoded bytes at
      // completion, and UTF-16 bytes immediately for definitely raw strings.
      if (/[^A-Za-z0-9+/_=\s-]/.test(block.signature) && block.signature.length * 2 > MAX_AFFINITY_PAYLOAD_BYTES) throw new InvalidAffinityStateError()
      if (event.type === "content_block_stop") { checkOpaque(block.signature); blocks.delete(index) }
    }
    const key = String(event.item_id ?? event.output_index ?? "")
    if (event.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
      const text = (summaries.get(key) ?? "") + event.delta
      if (new TextEncoder().encode(JSON.stringify(text)).length > MAX_AFFINITY_PAYLOAD_BYTES) throw new InvalidAffinityStateError()
      summaries.set(key, text)
    }
    if (event.type === "response.output_item.done") summaries.delete(key)
    if (event.type === "content_block_start") checkMessageBlock(event.content_block)
    if (event.type === "message_start" && object(event.message) && Array.isArray(event.message.content)) for (const content of event.message.content) checkMessageBlock(content)
    if (["response.output_item.added", "response.output_item.done"].includes(String(event.type))) checkResponseItem(event.item)
    if (["response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed"].includes(String(event.type)) && object(event.response) && Array.isArray(event.response.output)) {
      for (const item of event.response.output) checkResponseItem(item)
    }
    yield frame
  }
}
export class AffinityEgress {
  private readonly closed = new Map<number, { key: string; id?: string }>()
  private readonly finalized = new Map<string, Record<string, unknown>>()
  private readonly items = new Map<string, Promise<Record<string, unknown>>>()
  constructor(private readonly affinity: RequestAffinity | undefined) {}
  private async item(protocol: AffinityProtocol, value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = this.affinity
    if (!state?.actual) return Promise.resolve(value)
    if (protocol === "responses" && value.type === "compaction"
      && state.plaintextCompactions?.has(JSON.stringify([value.id, value.encrypted_content]))) return Promise.resolve(value)
    const signable = protocol === "chat_completions" ? typeof value.reasoning_opaque === "string"
      : protocol === "gemini" ? typeof value.thoughtSignature === "string"
      : protocol === "responses" ? hasOpaque(value)
      : value.type === "thinking" ? typeof value.signature === "string" : value.type === "redacted_thinking" && typeof value.data === "string"
    if (!signable) return value
    const codec = state.codec ?? await state.loadCodec?.()
    if (!codec) return value
    const key = JSON.stringify([protocol, value])
    const cached = this.items.get(key)
    if (cached) return cached
    const stamped = stampAffinityItem(protocol, value, state.actual, codec)
    this.items.set(key, stamped)
    return stamped
  }
  async body<T>(protocol: AffinityProtocol, body: T): Promise<T> {
    if (!object(body) || !this.affinity?.actual) return body
    if (protocol === "chat_completions" && Array.isArray(body.choices)) return { ...body, choices: await Promise.all(body.choices.map(async choice => object(choice) && object(choice.message) ? { ...choice, message: await this.item(protocol, choice.message) } : choice)) } as T
    if (protocol === "gemini" && Array.isArray(body.candidates)) return { ...body, candidates: await Promise.all(body.candidates.map(async candidate => object(candidate) && object(candidate.content) && Array.isArray(candidate.content.parts)
      ? { ...candidate, content: { ...candidate.content, parts: await Promise.all(candidate.content.parts.map(part => object(part) ? this.item(protocol, part) : part)) } } : candidate)) } as T
    const key = protocol === "responses" ? "output" : "content"
    const values = body[key]
    if (!Array.isArray(values)) return body
    const closed = [...this.closed].sort(([left], [right]) => left - right).map(([, value]) => value)
    return { ...body, [key]: await Promise.all(values.map((item, index) => {
      if (!object(item)) return item
      if (protocol === "responses") {
        const exact = this.finalized.get(itemKey(item, index))
        if (exact) return exact
        // ResponsesFinalOutput compacts sparse closed indices before egress.
        // Mirror its ID-or-position rule for an item lacking an ID on either side.
        const prior = closed[index]
        const positional = prior && (!prior.id || !item.id) ? this.finalized.get(prior.key) : undefined
        if (positional) return positional
      }
      return this.item(protocol, item)
    })) } as T
  }
  async *chat<T>(frames: AsyncIterable<ProtocolFrame<T>>): AsyncGenerator<ProtocolFrame<T>> {
    if (!this.affinity?.actual) { yield* frames; return }
    const states = new Map<number, { thinking: string; signature: string; hasSignature: boolean; hasThinking: boolean }>()
    const finished = new Set<number>()
    const pending = () => [...states.values()].some(state => state.hasSignature || state.hasThinking)
    for await (const frame of frames) {
      if (frame.type === "done" && pending()) throw new InvalidAffinityStateError()
      if (frame.type !== "event" || !object(frame.event) || !Array.isArray(frame.event.choices)) { yield frame; continue }
      const choices: unknown[] = []
      for (const choice of frame.event.choices) {
        if (!object(choice) || !object(choice.delta)) { choices.push(choice); continue }
        const index = typeof choice.index === "number" ? choice.index : 0
        const delta = choice.delta
        if (finished.has(index)) throw new InvalidAffinityStateError()
        const state = states.get(index) ?? { thinking: "", signature: "", hasSignature: false, hasThinking: false }
        const thinking = chatReasoningText(delta)
        state.hasThinking ||= thinking !== undefined
        state.thinking += thinking ?? ""
        if (typeof delta.reasoning_opaque === "string") { state.signature += delta.reasoning_opaque; state.hasSignature = true }
        boundedBlock(state)
        const { reasoning_opaque: _opaque, reasoning_text: _text, reasoning_content: _content, reasoning: _reasoning, ...visible } = delta
        if (choice.finish_reason != null) {
          if (state.hasThinking || state.hasSignature) visible.reasoning_text = state.thinking
          if (state.hasSignature) {
            const item = await this.item("chat_completions", { reasoning_text: state.thinking, reasoning_opaque: state.signature })
            visible.reasoning_opaque = item.reasoning_opaque
          }
          states.delete(index)
          finished.add(index)
        } else states.set(index, state)
        if (states.size + finished.size > 1024) throw new InvalidAffinityStateError()
        choices.push({ ...choice, delta: visible })
      }
      yield { ...frame, event: { ...frame.event, choices } as T }
    }
    if (pending()) throw new InvalidAffinityStateError()
  }
  async *gemini(frames: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    for await (const frame of frames) yield await this.body("gemini", frame)
  }
  async responseEvent<T>(event: T): Promise<T> {
    if (!object(event) || !this.affinity?.actual) return event
    if (event.type === "response.output_item.done" && object(event.item)) {
      const index = typeof event.output_index === "number" ? event.output_index : this.closed.size
      const key = itemKey(event.item, index)
      const id = typeof event.item.id === "string" && event.item.id ? event.item.id : undefined
      if (id) for (const [previous, value] of this.closed) if (value.id === id) this.closed.delete(previous)
      this.closed.set(index, { key, id })
      const item = this.finalized.get(key) ?? await this.item("responses", event.item)
      // Once an authenticated item is emitted, its bound companion cannot change
      // in the terminal envelope or durable snapshot.
      if (hasOpaque(item)) this.finalized.set(key, item)
      return { ...event, item } as T
    }
    if (["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))) return { ...event, response: await this.body("responses", event.response) } as T
    // Added/created/in-progress frames may carry incomplete opaque companions.
    // Only finalized item/terminal paths above are allowed to expose those slots.
    return stripOpaque(event) as T
  }
  async *messages<T>(frames: AsyncIterable<ProtocolFrame<T>>): AsyncGenerator<ProtocolFrame<T>> {
    if (!this.affinity?.actual) { yield* frames; return }
    const blocks = new Map<number, { thinking: string; signature: string }>()
    for await (const frame of frames) {
      if (frame.type !== "event" || !object(frame.event)) { yield frame; continue }
      const event = frame.event
      const index = typeof event.index === "number" ? event.index : -1
      if (event.type === "content_block_start" && object(event.content_block)) {
        const block = event.content_block
        if (block.type === "thinking") {
          blocks.set(index, { thinking: typeof block.thinking === "string" ? block.thinking : "", signature: typeof block.signature === "string" ? block.signature : "" })
          const accumulated = blocks.get(index)
          if (accumulated) boundedBlock(accumulated)
          const { signature: _signature, ...rest } = block
          yield { ...frame, event: { ...event, content_block: rest } as T }
          continue
        }
        if (block.type === "redacted_thinking") {
          yield { ...frame, event: { ...event, content_block: await this.item("messages", block) } as T }
          continue
        }
      }
      const block = blocks.get(index)
      if (!block && event.type === "content_block_delta" && object(event.delta) && event.delta.type === "signature_delta") throw new InvalidAffinityStateError()
      if (block && event.type === "content_block_delta" && object(event.delta)) {
        if (event.delta.type === "signature_delta" && typeof event.delta.signature === "string") { block.signature += event.delta.signature; boundedBlock(block); continue }
        if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") { block.thinking += event.delta.thinking; boundedBlock(block) }
      }
      if (block && event.type === "content_block_stop") {
        if (block.signature) {
          const stamped = await this.item("messages", { type: "thinking", thinking: block.thinking, signature: block.signature })
          yield { ...frame, event: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: stamped.signature } } as T }
        }
        blocks.delete(index)
      }
      yield frame
    }
  }
}
