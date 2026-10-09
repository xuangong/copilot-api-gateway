export type ApiKeyUpstreamsNormalizationResult =
  | { ok: true; value: string[] | null }
  | { ok: false; reason: "not_array" | "invalid_id" | "duplicate_id" | "invalid_json" }

/** IDs are stable opaque references; trimming would silently change identity. */
export function normalizeApiKeyUpstreamIds(value: unknown): ApiKeyUpstreamsNormalizationResult {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (!Array.isArray(value)) return { ok: false, reason: "not_array" }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const id of value) {
    if (typeof id !== "string" || !id || id.trim() !== id) return { ok: false, reason: "invalid_id" }
    if (seen.has(id)) return { ok: false, reason: "duplicate_id" }
    seen.add(id)
    ids.push(id)
  }
  return { ok: true, value: ids }
}

export function parseStoredApiKeyUpstreamIds(value: unknown): ApiKeyUpstreamsNormalizationResult {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value !== "string") return { ok: false, reason: "invalid_json" }
  try {
    const parsed: unknown = JSON.parse(value)
    // SQL NULL alone means inheritance; a non-null malformed cell denies access.
    if (parsed === null) return { ok: false, reason: "not_array" }
    return normalizeApiKeyUpstreamIds(parsed)
  } catch { return { ok: false, reason: "invalid_json" } }
}
