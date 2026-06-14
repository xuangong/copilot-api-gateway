/**
 * Strip the `safety_identifier` field from a `/responses` payload.
 *
 * VSCode Copilot Chat does not insert `safety_identifier` on its
 * `/responses` calls. Native Responses callers may legitimately set it and
 * OpenAI proper accepts it — those values must flow through untouched.
 * When the request entered the gateway as a non-Responses shape (Messages
 * or Chat Completions translated to Responses), any value here was
 * synthesized during translation and must be dropped before forwarding to
 * Copilot.
 *
 * The caller decides whether to strip via the `sourceApi` ProviderFetch
 * option — this transform only mutates the field, the decision lives in
 * the provider.
 *
 * Adapted from copilot-gateway/Floway:
 * apps/api/src/data-plane/providers/copilot/interceptors/responses/strip-safety-identifier.ts
 */

import type { ResponsesPayload } from "./types"

export function stripSafetyIdentifier(payload: ResponsesPayload): boolean {
  const p = payload as ResponsesPayload & { safety_identifier?: unknown }
  if (!("safety_identifier" in p)) return false
  delete p.safety_identifier
  return true
}
