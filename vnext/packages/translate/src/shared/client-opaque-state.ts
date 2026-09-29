import { TranslatorValidationError } from "../errors.ts"

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Chat reasoning and Gemini thought Parts cannot reconstruct native continuation
 * items. Inspect only protocol slots, never similarly named business properties. */
export function assertClientRepresentableResponseItem(value: unknown): void {
  if (!object(value)) return
  const required = value.type === "program_output" || (["compaction", "compaction_summary", "context_compaction", "program"].includes(String(value.type))
    && (typeof value.encrypted_content === "string" || (value.type === "program" && typeof value.fingerprint === "string")))
  const nested = value.type === "agent_message" && Array.isArray(value.content) && value.content.some(part => object(part) && part.type === "encrypted_content" && typeof part.encrypted_content === "string")
  if (required || nested) throw new TranslatorValidationError("Native continuation state cannot be represented by this client protocol.", "output")
}

export function assertClientRepresentableResponseEvent(event: unknown): void {
  if (!object(event)) return
  if (["response.output_item.added", "response.output_item.done"].includes(String(event.type))) assertClientRepresentableResponseItem(event.item)
  if (["response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed"].includes(String(event.type)) && object(event.response) && Array.isArray(event.response.output)) {
    for (const item of event.response.output) assertClientRepresentableResponseItem(item)
  }
}
