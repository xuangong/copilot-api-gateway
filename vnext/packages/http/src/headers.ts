/**
 * mergeHeaders — flattens an init headers value (HeadersInit) into a plain
 * Record and lets `extra` override on key collision. Lifted verbatim from
 * @vibe-llm/provider-copilot/src/provider.ts mergeHeaders helper.
 *
 * Header names are lowercased by the Headers normalization that happens
 * inside `new Headers(initHeaders)`. Callers (CopilotProvider etc.) rely on
 * that behavior; do not change it.
 */
export function mergeHeaders(
  initHeaders: RequestInit['headers'] | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (initHeaders) {
    const h = new Headers(initHeaders)
    h.forEach((v, k) => { out[k] = v })
  }
  if (extra) Object.assign(out, extra)
  return out
}
