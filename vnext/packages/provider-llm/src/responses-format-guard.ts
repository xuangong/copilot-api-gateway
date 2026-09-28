/** Request-local guard: provider normalizers may not weaken translated Responses formats. */
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const formatOf = (payload: unknown, endpoint: string): unknown => {
  if (!object(payload)) return undefined
  return endpoint === 'chat_completions' ? payload.response_format
    : endpoint === 'messages' && object(payload.output_config) ? payload.output_config.format : undefined
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]))
  if (!object(a) || !object(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}
export const responsesFormatMismatchMessage = 'text.format: the selected upstream normalizers cannot preserve the requested format'

export function responsesFormatGuard(sourceProtocol: string | undefined, endpoint: string, payload: unknown): (normalized: unknown) => boolean {
  const format = sourceProtocol === 'responses' ? formatOf(payload, endpoint) : undefined
  const expected = format === undefined ? undefined : structuredClone(format)
  return normalized => expected === undefined || equal(expected, formatOf(normalized, endpoint))
}
