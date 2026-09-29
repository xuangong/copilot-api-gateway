import { affinityTargetMatch, parseAffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import { InvalidAffinityStateError } from "./carrier.ts"
import type { AffinityCodec, AffinityField, DecodedAffinity } from "./carrier.ts"

export type AffinityProtocol = "responses" | "messages"
export type AffinityCandidateClass = "exact" | "compatible" | "degraded" | "unavailable"
type JsonObject = Record<string, unknown>
type Path = readonly (string | number)[]
interface Slot { key: string; field: AffinityField }
interface Block { path: Path; slots: Slot[]; required: boolean; unsafeToRemove: boolean }
interface OwnedBlock extends Block { decoded: Array<{ key: string; state: Extract<DecodedAffinity, { kind: "owned" }> }> }

export class AffinityRoutingUnavailableError extends Error {
  readonly code = "affinity_routing_unavailable"
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

/** Egress building block only. Call after actual execution identity is finalized. */
export async function stampAffinityItem(protocol: AffinityProtocol, item: Readonly<JsonObject>, target: AffinityExecutionTarget, codec: AffinityCodec): Promise<JsonObject> {
  const copy: JsonObject = structuredClone({ ...item })
  for (const slot of slots(protocol, copy)) {
    const value = copy[slot.key]
    if (typeof value === "string") copy[slot.key] = await codec.encode(value, target, slot.field)
  }
  return copy
}

function blocks(protocol: AffinityProtocol, body: JsonObject): Block[] {
  const found: Block[] = []
  if (protocol === "responses") {
    if (!Array.isArray(body.input)) return found
    body.input.forEach((item, index) => {
      if (!object(item)) return
      found.push({ path: ["input", index], slots: slots(protocol, item),
        required: ["compaction", "compaction_summary", "context_compaction", "program", "program_output"].includes(String(item.type)), unsafeToRemove: false })
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

export interface AffinityAnalysis {
  classify(target: AffinityExecutionTarget): AffinityCandidateClass
  /** Input candidates must already satisfy owner/key/alias/disabled/pin policy. */
  rankAuthorizedCandidates<T>(candidates: readonly T[], targetOf: (candidate: T) => AffinityExecutionTarget): T[]
  /** Fresh clone per attempt. Required mismatch fails before provider invocation. */
  materialize(target: AffinityExecutionTarget): JsonObject
}

/** Run after A14 plaintext-envelope expansion and policy authorization, before
 * candidate dispatch. No stable API-key codec means the existing raw behavior. */
export async function analyzeAffinityRequest(protocol: AffinityProtocol, body: Readonly<JsonObject>, codec?: AffinityCodec): Promise<AffinityAnalysis> {
  const snapshot: JsonObject = structuredClone({ ...body })
  const owned: OwnedBlock[] = []
  if (codec) for (const block of blocks(protocol, snapshot)) {
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
  const shouldRemove = (block: OwnedBlock, target: AffinityExecutionTarget) => block.decoded.some(({ state }) => state.synthetic || affinityTargetMatch(state.target, target) === "incompatible")
  const classify = (input: AffinityExecutionTarget): AffinityCandidateClass => {
    const target = parseAffinityExecutionTarget(input)
    let result: AffinityCandidateClass = "exact"
    for (const block of owned) {
      if (shouldRemove(block, target)) {
        if (block.required || block.unsafeToRemove) return "unavailable"
        result = "degraded"
      } else if (result === "exact" && block.decoded.some(({ state }) => affinityTargetMatch(state.target, target) === "compatible")) result = "compatible"
    }
    return result
  }
  return Object.freeze({
    classify,
    rankAuthorizedCandidates<T>(candidates: readonly T[], targetOf: (candidate: T) => AffinityExecutionTarget): T[] {
      const ranks = { exact: 0, compatible: 1, degraded: 2, unavailable: 3 }
      return candidates.map((candidate, index) => ({ candidate, index, rank: ranks[classify(targetOf(candidate))] }))
        .filter(entry => entry.rank < 3).sort((a, b) => a.rank - b.rank || a.index - b.index).map(entry => entry.candidate)
    },
    materialize(target: AffinityExecutionTarget): JsonObject {
      if (classify(target) === "unavailable") throw new AffinityRoutingUnavailableError()
      const copy = structuredClone(snapshot)
      // Descending paths avoid index shifts during whole-block removal.
      const removedMessages = new Set<number>()
      for (const block of [...owned].reverse()) {
        if (shouldRemove(block, target)) {
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
      if (protocol === "messages" && Array.isArray(copy.messages)) copy.messages = copy.messages.filter((message, index) =>
        !removedMessages.has(index) || !object(message) || message.role !== "assistant" || !Array.isArray(message.content) || message.content.length > 0)
      return copy
    },
  })
}
