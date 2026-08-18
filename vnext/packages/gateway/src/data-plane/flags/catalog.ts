/**
 * Flag catalog — control-plane view.
 *
 * The catalog data itself lives in `@vibe-llm/protocols/flags` so the
 * provider packages can read it without importing the gateway (gateway
 * depends on the providers, not the reverse). This module re-exports it
 * and adds the wire-validation helpers only the control plane needs.
 */

import { OPTIONAL_FLAGS, type Flag, type OptionalFlagId } from "@vibe-llm/protocols/flags"

export { OPTIONAL_FLAGS, defaultsForUpstream } from "@vibe-llm/protocols/flags"
export type { Flag, OptionalFlagId } from "@vibe-llm/protocols/flags"

const KNOWN_IDS = new Set<string>(OPTIONAL_FLAGS.map((f) => f.id))

export function getFlagCatalog(): readonly Flag[] {
  return OPTIONAL_FLAGS
}

export function isKnownFlagId(id: string): id is OptionalFlagId {
  return KNOWN_IDS.has(id)
}

/**
 * Wire-form validator for control-plane endpoints that accept
 * flag_overrides JSON. Returns the validated record; throws on malformed
 * input. Unknown flag ids are silently dropped so older clients survive
 * catalog removals.
 */
export function parseFlagOverridesWire(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("flag_overrides must be an object of { flagId: boolean }")
  }
  const result: Record<string, boolean> = {}
  for (const [id, on] of Object.entries(value)) {
    if (typeof on !== "boolean") {
      throw new Error(`flag_overrides.${id} must be a boolean`)
    }
    if (isKnownFlagId(id)) result[id] = on
  }
  return result
}
