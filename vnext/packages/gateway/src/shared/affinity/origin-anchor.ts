import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { AffinityProtocol } from "./analysis.ts"
import { InvalidAffinityStateError } from "./carrier.ts"
import type { AffinityCodec, AffinityField } from "./carrier.ts"

type JsonObject = Record<string, unknown>
interface OriginSlot { readonly key: string; readonly field: AffinityField; readonly syntheticItem: boolean }

/** Synthetic deletion is an authenticated claim plus an exact empty shape.
 * Metadata slots on real Chat/Gemini content never authorize whole-item removal. */
export function affinityOriginSlot(protocol: AffinityProtocol, item: Readonly<JsonObject>): OriginSlot {
  if (protocol === "chat_completions") {
    if (item.role !== "assistant") throw new InvalidAffinityStateError()
    return { key: "reasoning_opaque", field: { domain: "chat_completions/reasoning/reasoning_opaque" }, syntheticItem: false }
  }
  if (protocol === "gemini") {
    return { key: "thoughtSignature", field: { domain: "gemini/part/thoughtSignature" }, syntheticItem: false }
  }
  if (protocol === "messages") {
    if (item.type !== "redacted_thinking" || Object.keys(item).some(key => key !== "type" && key !== "data")) throw new InvalidAffinityStateError()
    return { key: "data", field: { domain: "messages/redacted_thinking/data" }, syntheticItem: true }
  }
  if (item.type !== "reasoning" || !Array.isArray(item.summary) || item.summary.length !== 0
    || Object.keys(item).some(key => !["type", "summary", "encrypted_content", "id", "status"].includes(key))
    || (item.id !== undefined && typeof item.id !== "string")
    || (item.status !== undefined && typeof item.status !== "string")) throw new InvalidAffinityStateError()
  return { key: "encrypted_content", field: { domain: "responses/reasoning/encrypted_content" }, syntheticItem: true }
}

/** Call only with trusted actual execution identity, after natural state stamping. */
export async function stampAffinityOrigin(protocol: AffinityProtocol, item: Readonly<JsonObject>, target: AffinityExecutionTarget, codec: AffinityCodec): Promise<JsonObject> {
  const slot = affinityOriginSlot(protocol, item)
  // A natural empty string is still native state and must not be overwritten.
  if (item[slot.key] !== undefined) throw new InvalidAffinityStateError()
  return { ...structuredClone(item), [slot.key]: await codec.encodeOrigin(target, slot.field, { syntheticItem: slot.syntheticItem }) }
}
