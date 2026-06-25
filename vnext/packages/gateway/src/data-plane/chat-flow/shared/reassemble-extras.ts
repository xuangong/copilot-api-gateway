/**
 * Field-fidelity primitive shared by every reassembler that turns an upstream
 * SSE stream (or single non-streaming JSON envelope) into a single result
 * object. Reassemblers reach for typed accumulators on the fields they
 * understand (string concat, array merge by index, etc.); this helper covers
 * everything else so a future upstream extension survives without a code
 * change.
 *
 * Ported from copilot-gateway/packages/gateway/src/shared/reassemble-extras.ts —
 * verbatim semantics so vendor padding fields (content_filter_results,
 * prompt_filter_results, service_tier, copilot_usage, message.padding) and
 * any future Copilot/OpenAI/Anthropic extension reach the client untouched.
 *
 * Accumulation rules:
 *  - String + string: concatenate (streaming text fields).
 *  - Array of objects with numeric `index` + same shape: merge by index,
 *    recursing into string fields. Mirrors `tool_calls` streaming shape.
 *  - Plain object + plain object: shallow merge. Last write wins per key.
 *  - Anything else: last non-null value wins.
 */

const isPlainArray = (value: unknown): value is unknown[] => Array.isArray(value)
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const accumulate = (acc: Record<string, unknown>, key: string, value: unknown): void => {
  if (value === undefined || value === null) return
  const existing = acc[key]

  if (typeof existing === 'string' && typeof value === 'string') {
    acc[key] = existing + value
    return
  }

  if (isPlainArray(existing) && isPlainArray(value) && existing.every(isPlainObject) && value.every(isPlainObject)) {
    const merged = [...existing] as Record<string, unknown>[]
    for (const incoming of value as Record<string, unknown>[]) {
      const idx = typeof incoming.index === 'number' ? incoming.index : -1
      if (idx >= 0 && isPlainObject(merged[idx])) {
        const into = merged[idx]
        for (const [k, v] of Object.entries(incoming)) {
          if (k === 'index') continue
          if (typeof into[k] === 'string' && typeof v === 'string') into[k] = into[k] + v
          else if (isPlainObject(into[k]) && isPlainObject(v)) into[k] = { ...into[k], ...v }
          else if (v !== undefined && v !== null) into[k] = v
        }
      } else if (idx >= 0) {
        merged[idx] = incoming
      } else {
        merged.push(incoming)
      }
    }
    acc[key] = merged
    return
  }

  if (isPlainObject(existing) && isPlainObject(value)) {
    acc[key] = { ...existing, ...value }
    return
  }

  acc[key] = value
}

export const captureExtras = (
  source: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  into: Record<string, unknown>,
): void => {
  for (const [key, value] of Object.entries(source)) {
    if (knownKeys.has(key)) continue
    accumulate(into, key, value)
  }
}
