import type { ProbeResult } from "./types"

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
    return { ok: false, status, error: message }
  }
}

function extractStatus(err: Error): number | undefined {
  const maybe = err as Error & { status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
  if (typeof maybe.status === "number") return maybe.status
  if (typeof maybe.statusCode === "number") return maybe.statusCode
  if (typeof maybe.response?.status === "number") return maybe.response.status
  return undefined
}
