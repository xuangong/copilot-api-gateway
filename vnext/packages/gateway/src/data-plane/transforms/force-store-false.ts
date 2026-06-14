/**
 * Copilot's `/responses` rejects `store: true` with
 * `400 {"error":{"message":"store is not supported","code":"unsupported_value","param":"store"}}`.
 * Force `store: false` on the outgoing payload. The caller's original intent
 * is irrelevant once we're on the Copilot Responses upstream — Copilot never
 * persists, so any non-false value would just be rejected at the edge.
 *
 * Adapted from copilot-gateway/Floway:
 * apps/api/src/data-plane/providers/copilot/interceptors/responses/force-store-false.ts
 */
export function forceStoreFalse(payload: Record<string, unknown>): void {
  payload.store = false
}
