import type { ProbeResult } from './types'

/**
 * Map low-level probe failures to a one-line "what to check next" hint
 * so admins don't have to grok raw fetch / TLS errors. Cheap pattern
 * matching — falls through to the raw error message when nothing
 * recognizable surfaces.
 */
function diagnoseHint(status: number | undefined, message: string): string | undefined {
  const m = message.toLowerCase()
  if (status === 401 || /\b401\b|unauthorized|invalid.*api[- ]?key/.test(m)) return "401 — check the apiKey is correct and active."
  if (status === 403 || /\b403\b|forbidden/.test(m)) return "403 — apiKey is valid but lacks permission for this resource."
  if (status === 404 || /\b404\b|not found/.test(m)) return "404 — check the baseUrl path and that /models is implemented (or use Manual models list)."
  if (status === 429 || /\b429\b|rate limit/.test(m)) return "429 — upstream rate-limited the probe; wait and retry."
  if (/timeout|timed out|esockettimedout/.test(m)) return "Timeout — upstream took too long to respond; check connectivity or upstream health."
  if (/getaddrinfo|enotfound|dns|typo in the url|unable to connect/.test(m)) return "Network error — hostname did not resolve or unreachable; double-check the endpoint URL."
  if (/econnrefused/.test(m)) return "Connection refused — port closed or service not running at this URL."
  if (/certificate|cert|self.?signed|ssl|tls/.test(m)) return "TLS/cert error — upstream certificate is invalid or self-signed."
  if (status && status >= 500) return `${status} — upstream is currently unhealthy; not a config problem on your side.`
  return undefined
}

/**
 * Shared probe helper used by every provider. Wraps a `getModels()`-style
 * promise and normalizes both success and exception paths into a uniform
 * ProbeResult shape that the control-plane returns to the dashboard
 * verbatim. Capping error length / model list so a malicious or chatty
 * upstream can't blow up the JSON response.
 */
export async function probeViaModels(
  fn: () => Promise<{ data?: Array<{ id?: string }> }>,
): Promise<ProbeResult> {
  try {
    const res = await fn()
    const data = (res.data ?? []) as Array<{ id?: string }>
    const ids = data
      .map((m) => (typeof m?.id === "string" ? m.id : null))
      .filter((s): s is string => Boolean(s))
    return {
      ok: true,
      modelCount: ids.length,
      models: ids.slice(0, 50),
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    const message = err.message.slice(0, 1000)
    const status = extractStatus(err)
    const hint = diagnoseHint(status, err.message)
    return { ok: false, status, error: message, hint }
  }
}

function extractStatus(err: Error): number | undefined {
  const maybe = err as Error & { status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
  if (typeof maybe.status === "number") return maybe.status
  if (typeof maybe.statusCode === "number") return maybe.statusCode
  if (typeof maybe.response?.status === "number") return maybe.response.status
  return undefined
}
