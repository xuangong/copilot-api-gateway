import type { ResponsesWebSearchAction } from "@vibe-llm/protocols/responses"
import type { WebSearchCallIR } from "../../tools/web-search/operations"

/**
 * Private `payload.private` replay shape for one `web_search_call`. A shim call
 * carrying several operations fans out into one wsc per operation, each with
 * its own payload — so this is always one wsc and one op, never an array to
 * denormalize. The persisted-payload key IS the wsc id, so we don't repeat it
 * inside.
 *
 * - `functionCallItem` is the function_call this wsc replays as: the
 *   upstream's own item when the call produced a single wsc, otherwise a
 *   synthetic per-slot one (suffixed call_id, `arguments` naming only this
 *   slot's operation) so N replayed calls read as N honest requests rather
 *   than N copies of the same one. Either way `arguments` is the
 *   jsonrepair-canonical strict-JSON form, and type/name/status pass through
 *   untouched, so the upstream model's prior assistant turn stays well-formed.
 *
 * - `ir` stores the action, structured results, and optional upstream
 *   model-facing output straight from `planShimSlots`. Replay uses
 *   `renderWebSearchCallOutput`, which preserves that output when present
 *   and otherwise renders the action and results.
 *
 * Version-tagged: an unknown `v` falls through the no-payload branch in
 * `transformInputItemsForWebSearch` (action re-serialized into the
 * shim call shape, output replaced with the not-preserved notice). Starts
 * at 1; bump only on a wire-incompatible change after release.
 */
// Values are borrowed, not frozen snapshots.
export interface WebSearchCallPrivatePayload {
  v: 1
  functionCallItem: {
    type: "function_call"
    call_id: string
    name: string
    arguments: string
    status?: string
    [key: string]: unknown
  }
  ir: WebSearchCallIR
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string"
const action = (value: unknown): value is ResponsesWebSearchAction => {
  if (!object(value)) return false
  switch (value.type) {
    case "search": return optionalString(value.query)
      && (value.queries === undefined || (Array.isArray(value.queries) && value.queries.every(query => typeof query === "string")))
      && (value.sources === undefined || (Array.isArray(value.sources) && value.sources.every(source => object(source) && source.type === "url" && typeof source.url === "string")))
    case "open_page": return optionalString(value.url)
    case "find_in_page": return typeof value.url === "string" && typeof value.pattern === "string"
    default: return false
  }
}

/** Legacy injected storage is foreign input. Validate only fields the replay renderer consumes. */
export function decodeWebSearchPrivatePayload(value: unknown): WebSearchCallPrivatePayload | undefined {
  if (!object(value) || value.v !== 1 || !object(value.functionCallItem) || !object(value.ir)) return undefined
  const call = value.functionCallItem
  const ir = value.ir
  if (call.type !== "function_call" || typeof call.call_id !== "string" || typeof call.name !== "string"
    || typeof call.arguments !== "string" || !optionalString(call.status)) return undefined
  if (!action(ir.action) || !Array.isArray(ir.results) || !optionalString(ir.outputText)) return undefined
  if (!ir.results.every(result => object(result) && result.type === "text_result" && typeof result.url === "string"
    && typeof result.title === "string" && typeof result.snippet === "string")) return undefined
  return value as unknown as WebSearchCallPrivatePayload
}
