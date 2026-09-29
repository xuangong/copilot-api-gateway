import { chatReasoningText } from "@vibe-llm/translate/shared/chat-reasoning-text"
import { decodeOpaqueValue, splitOpaqueTrailer } from "@vibe-llm/protocols/common"
import { affinityTargetMatch, parseAffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import { AFFINITY_MARKER, MAX_AFFINITY_WIRE_CHARS, MAX_AFFINITY_PAYLOAD_BYTES, InvalidAffinityStateError } from "./carrier.ts"
import type { AffinityCodec, AffinityField, DecodedAffinity } from "./carrier.ts"

export type AffinityProtocol = "responses" | "messages" | "chat_completions" | "gemini"
export type AffinityCandidateClass = "exact" | "compatible" | "degraded" | "unavailable"
type JsonObject = Record<string, unknown>
type Path = readonly (string | number)[]
interface Slot { key: string; field: AffinityField }
interface Block { path: Path; slots: Slot[]; required: boolean; unsafeToRemove: boolean }
interface OwnedBlock extends Block { decoded: Array<{ key: string; state: Extract<DecodedAffinity, { kind: "owned" }> }> }

export class AffinityRoutingUnavailableError extends Error {
  readonly code = "affinity_routing_unavailable"
  readonly status = 503
  constructor() {
    super("No authorized compatible route for opaque state")
    this.name = "AffinityRoutingUnavailableError"
  }
}
function object(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value) }
function at(root: JsonObject, path: Path): unknown {
  let value: unknown = root
  for (const key of path) {
    if (typeof key === "number" && Array.isArray(value)) value = value[key]
    else if (typeof key === "string" && object(value)) value = value[key]
    else throw new InvalidAffinityStateError()
  }
  return value
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function slots(protocol: AffinityProtocol, item: JsonObject): Slot[] {
  if (protocol === "chat_completions") return typeof item.reasoning_opaque === "string"
    ? [{ key: "reasoning_opaque", field: { domain: "chat_completions/reasoning/reasoning_opaque", block: JSON.stringify({ reasoning_text: chatReasoningText(item) ?? "" }) } }] : []
  if (protocol === "gemini") return typeof item.thoughtSignature === "string"
    ? [{ key: "thoughtSignature", field: { domain: "gemini/part/thoughtSignature", block: JSON.stringify(canonical(Object.fromEntries(Object.entries(item).filter(([key]) => key !== "thoughtSignature")))) } }] : []
  const type = item.type
  if (typeof type !== "string") return []
  let keys: string[] = []
  let companion: JsonObject = {}
  let domainType = type
  if (protocol === "messages") {
    if (type === "thinking") {
      keys = ["signature"]
      companion = { thinking: item.thinking }
    }
    if (type === "redacted_thinking") keys = ["data"]
  } else {
    if (["compaction_summary", "context_compaction"].includes(type)) domainType = "compaction"
    if (["reasoning", "compaction", "compaction_summary", "context_compaction", "program", "program_output"].includes(type)) keys = ["encrypted_content"]
    if (type === "program" || type === "program_output") keys.push("fingerprint")
    // Bind visible companion content, excluding mutable protocol ids and aliases.
    companion = Object.fromEntries(["summary", "content", "code", "result", "call_id"].filter(key => item[key] !== undefined).map(key => [key, item[key]]))
  }
  const block = JSON.stringify(canonical(companion))
  return keys.filter(key => typeof item[key] === "string").map(key => ({ key, field: { domain: `${protocol}/${domainType}/${key}`, block } }))
}

async function agentField(item: JsonObject, carried: boolean): Promise<AffinityField> {
  const content = Array.isArray(item.content) ? item.content.map(value => object(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "encrypted_content")) : value) : []
  const values = Array.isArray(item.content) ? item.content.flatMap(value =>
    object(value) && value.type === "encrypted_content" && typeof value.encrypted_content === "string" ? [value.encrypted_content] : []) : []
  const companion = { author: item.author, recipient: item.recipient, agent: item.agent, content }
  if (values.length < 2) return { domain: "responses/agent_message/encrypted_content", block: JSON.stringify(canonical(companion)) }
  // Original bytes are public in the opaque carrier. Their untrusted digests
  // construct AAD only: every carried slot must then authenticate that same group.
  // A sorted multiset binds duplication/substitution without binding positions.
  const commitment = await Promise.all(values.map(async value => {
    let bytes: Uint8Array
    if (carried && value.startsWith(AFFINITY_MARKER)) {
      if (!value.startsWith(`${AFFINITY_MARKER}1:`) || value.length > MAX_AFFINITY_WIRE_CHARS) throw new InvalidAffinityStateError()
      const split = splitOpaqueTrailer(value.slice(AFFINITY_MARKER.length + 2), 28)
      if (!split || split.original.length > MAX_AFFINITY_PAYLOAD_BYTES) throw new InvalidAffinityStateError()
      bytes = split.original
    } else {
      if (value.length > MAX_AFFINITY_PAYLOAD_BYTES) throw new InvalidAffinityStateError()
      bytes = decodeOpaqueValue(value).bytes
    }
    if (bytes.length > MAX_AFFINITY_PAYLOAD_BYTES) throw new InvalidAffinityStateError()
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
  }))
  return { domain: "responses/agent_message/encrypted_content/group-v2", block: JSON.stringify(canonical({ ...companion, opaqueGroup: commitment.sort() })) }
}

/** Egress building block only. Call after actual execution identity is finalized. */
export async function stampAffinityItem(protocol: AffinityProtocol, item: Readonly<JsonObject>, target: AffinityExecutionTarget, codec: AffinityCodec): Promise<JsonObject> {
  const copy: JsonObject = structuredClone({ ...item })
  for (const slot of slots(protocol, copy)) {
    const value = copy[slot.key]
    if (typeof value === "string") copy[slot.key] = await codec.encode(value, target, slot.field)
  }
  if (protocol === "responses" && item.type === "agent_message" && Array.isArray(copy.content)) {
    const field = await agentField(item, false)
    for (const block of copy.content) if (object(block) && block.type === "encrypted_content" && typeof block.encrypted_content === "string") {
      block.encrypted_content = await codec.encode(block.encrypted_content, target, field)
    }
  }
  return copy
}

async function blocks(protocol: AffinityProtocol, body: JsonObject): Promise<Block[]> {
  const found: Block[] = []
  if (protocol === "responses") {
    if (!Array.isArray(body.input)) return found
    for (const [index, item] of body.input.entries()) {
      if (!object(item)) continue
      if (item.type === "agent_message" && Array.isArray(item.content)) {
        const field = await agentField(item, true)
        item.content.forEach((block, blockIndex) => {
          if (object(block) && block.type === "encrypted_content" && typeof block.encrypted_content === "string") found.push({
            path: ["input", index, "content", blockIndex], slots: [{ key: "encrypted_content", field }], required: true, unsafeToRemove: true,
          })
        })
      }
      found.push({ path: ["input", index], slots: slots(protocol, item),
        required: ["compaction", "compaction_summary", "context_compaction", "program", "program_output"].includes(String(item.type)), unsafeToRemove: false })
    }
  } else if (protocol === "gemini") {
    if (!Array.isArray(body.contents)) return found
    body.contents.forEach((content, index) => {
      if (!object(content) || !Array.isArray(content.parts)) return
      if (content.role !== "model" && content.parts.some(part => object(part) && typeof part.thoughtSignature === "string" && part.thoughtSignature.startsWith(AFFINITY_MARKER))) throw new InvalidAffinityStateError()
      const hasTool = content.parts.some(part => object(part) && part.functionCall !== undefined)
      content.parts.forEach((part, partIndex) => {
        if (!object(part)) return
        const optional = part.thought === true && typeof part.text === "string" && Object.keys(part).every(key => ["text", "thought", "thoughtSignature"].includes(key))
        found.push({ path: ["contents", index, "parts", partIndex], slots: slots(protocol, part), required: !optional, unsafeToRemove: content.role !== "model" || hasTool })
      })
    })
  } else if (protocol === "chat_completions") {
    if (!Array.isArray(body.messages)) return found
    body.messages.forEach((message, index) => {
      if (!object(message)) return
      if (message.role !== "assistant" && typeof message.reasoning_opaque === "string" && message.reasoning_opaque.startsWith(AFFINITY_MARKER)) throw new InvalidAffinityStateError()
      const next = body.messages instanceof Array ? body.messages[index + 1] : undefined
      found.push({ path: ["messages", index], slots: slots(protocol, message), required: false,
        unsafeToRemove: message.role !== "assistant" || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) || (object(next) && next.role === "tool") })
    })
  } else {
    if (!Array.isArray(body.messages)) return found
    const messages = body.messages
    messages.forEach((message, index) => {
      if (!object(message) || !Array.isArray(message.content)) return
      const next = messages[index + 1]
      const hasTool = message.content.some(block => object(block) && block.type === "tool_use")
        || (object(next) && Array.isArray(next.content) && next.content.some(block => object(block) && block.type === "tool_result"))
      message.content.forEach((item, blockIndex) => {
        if (!object(item)) return
        found.push({ path: ["messages", index, "content", blockIndex], slots: slots(protocol, item), required: false,
          unsafeToRemove: message.role !== "assistant" || hasTool })
      })
    })
  }
  return found
}

export function containsAffinityMarker(protocol: AffinityProtocol, body: Readonly<JsonObject>): boolean {
  const marked = (value: unknown) => typeof value === "string" && value.startsWith(AFFINITY_MARKER)
  if (protocol === "chat_completions") return Array.isArray(body.messages) && body.messages.some(message => object(message) && marked(message.reasoning_opaque))
  if (protocol === "gemini") return Array.isArray(body.contents) && body.contents.some(content => object(content) && Array.isArray(content.parts) && content.parts.some(part => object(part) && marked(part.thoughtSignature)))
  if (protocol === "responses") return Array.isArray(body.input) && body.input.some(item => {
    if (!object(item)) return false
    if (item.type === "agent_message" && Array.isArray(item.content)) return item.content.some(block => object(block) && block.type === "encrypted_content" && marked(block.encrypted_content))
    if (["reasoning", "compaction", "compaction_summary", "context_compaction", "program", "program_output"].includes(String(item.type))) {
      return marked(item.encrypted_content) || ((item.type === "program" || item.type === "program_output") && marked(item.fingerprint))
    }
    return false
  })
  return Array.isArray(body.messages) && body.messages.some(message => object(message) && Array.isArray(message.content)
    && message.content.some(block => object(block) && (block.type === "thinking" ? marked(block.signature) : block.type === "redacted_thinking" && marked(block.data))))
}

export interface AffinityAnalysis {
  readonly hasOwned: boolean
  readonly hasRequiredOwned: boolean
  classify(target: AffinityExecutionTarget | undefined): AffinityCandidateClass
  /** Input candidates must already satisfy owner/key/alias/disabled/pin policy. */
  rankAuthorizedCandidates<T>(candidates: readonly T[], targetOf: (candidate: T) => AffinityExecutionTarget | undefined): T[]
  /** Fresh clone per attempt. Required mismatch fails before provider invocation. */
  materialize(target: AffinityExecutionTarget | undefined): JsonObject
}

/** Run after A14 plaintext-envelope expansion and policy authorization, before
 * candidate dispatch. No stable API-key codec means the existing raw behavior. */
export async function analyzeAffinityRequest(protocol: AffinityProtocol, body: Readonly<JsonObject>, codec?: AffinityCodec): Promise<AffinityAnalysis> {
  const snapshot: JsonObject = structuredClone({ ...body })
  const owned: OwnedBlock[] = []
  if (codec) for (const block of await blocks(protocol, snapshot)) {
    const item = at(snapshot, block.path)
    if (!object(item)) throw new InvalidAffinityStateError()
    const decoded: OwnedBlock["decoded"] = []
    for (const slot of block.slots) {
      const value = item[slot.key]
      if (typeof value !== "string") throw new InvalidAffinityStateError()
      const state = await codec.decode(value, slot.field)
      if (state.kind === "owned") decoded.push({ key: slot.key, state })
    }
    if (decoded.length) owned.push({ ...block, decoded })
  }
  const shouldRemove = (block: OwnedBlock, target: AffinityExecutionTarget | undefined) => block.decoded.some(({ state }) => state.synthetic || !target || affinityTargetMatch(state.target, target) === "incompatible")
  const classify = (input: AffinityExecutionTarget | undefined): AffinityCandidateClass => {
    const target = input === undefined ? undefined : parseAffinityExecutionTarget(input)
    let result: AffinityCandidateClass = "exact"
    for (const block of owned) {
      if (shouldRemove(block, target)) {
        if (block.required || block.unsafeToRemove) return "unavailable"
        result = "degraded"
      } else if (target && result === "exact" && block.decoded.some(({ state }) => affinityTargetMatch(state.target, target) === "compatible")) result = "compatible"
    }
    return result
  }
  return Object.freeze({
    hasOwned: owned.length > 0,
    hasRequiredOwned: owned.some(block => block.required),
    classify,
    rankAuthorizedCandidates<T>(candidates: readonly T[], targetOf: (candidate: T) => AffinityExecutionTarget | undefined): T[] {
      const ranks = { exact: 0, compatible: 1, degraded: 2, unavailable: 3 }
      return candidates.map((candidate, index) => ({ candidate, index, rank: ranks[classify(targetOf(candidate))] }))
        .filter(entry => entry.rank < 3).sort((a, b) => a.rank - b.rank || a.index - b.index).map(entry => entry.candidate)
    },
    materialize(target: AffinityExecutionTarget | undefined): JsonObject {
      if (classify(target) === "unavailable") throw new AffinityRoutingUnavailableError()
      const copy = structuredClone(snapshot)
      // Descending paths avoid index shifts during whole-block removal.
      const removedMessages = new Set<number>()
      for (const block of [...owned].reverse()) {
        if (shouldRemove(block, target)) {
          if (protocol === "chat_completions") {
            const message = at(copy, block.path)
            if (!object(message)) throw new InvalidAffinityStateError()
            for (const key of ["reasoning_text", "reasoning_content", "reasoning", "reasoning_opaque", "reasoning_items"]) delete message[key]
            // The loose Chat schema can carry refusal, audio, or provider payloads.
            // Remove only a bare role with absent/empty text after stripping reasoning.
            if (Object.keys(message).every(key => key === "role" || (key === "content" && (message.content == null || message.content === "")))) removedMessages.add(Number(block.path[1]))
            continue
          }
          const parent = at(copy, block.path.slice(0, -1))
          const index = block.path.at(-1)
          if (!Array.isArray(parent) || typeof index !== "number") throw new InvalidAffinityStateError()
          parent.splice(index, 1)
          const messageIndex = block.path[1]
          if (protocol === "messages" && typeof messageIndex === "number") removedMessages.add(messageIndex)
        } else {
          const item = at(copy, block.path)
          if (!object(item)) throw new InvalidAffinityStateError()
          for (const { key, state } of block.decoded) item[key] = state.value
        }
      }
      if (protocol === "chat_completions" && Array.isArray(copy.messages)) copy.messages = copy.messages.filter((_, index) => !removedMessages.has(index))
      if (protocol === "gemini" && Array.isArray(copy.contents)) copy.contents = copy.contents.filter(content => !object(content) || content.role !== "model" || !Array.isArray(content.parts) || content.parts.length > 0)
      if (protocol === "messages" && Array.isArray(copy.messages)) copy.messages = copy.messages.filter((message, index) =>
        !removedMessages.has(index) || !object(message) || message.role !== "assistant" || !Array.isArray(message.content) || message.content.length > 0)
      return copy
    },
  })
}
