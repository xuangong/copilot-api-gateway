/**
 * Retry `/responses` calls that fail with Copilot's
 * "input item ID does not belong to this connection" error.
 *
 * Two sources of dangling references in `payload.input` items:
 *
 *   1. Base64-encoded item IDs are bound to the originating connection. We
 *      detect them ahead of time and replace with stable
 *      `prefix_<sha256:16>` IDs derived from the original.
 *
 *   2. `item_reference` items point to items on the originating connection.
 *      We drop them entirely on a hit (they have no inline content).
 *
 * Strategy: pre-fix with cached known-bad IDs (avoids a wasted roundtrip);
 * on the live error, collect every base64-looking ID in the payload, cache
 * them, fix, and retry exactly once. Two attempts max.
 *
 * Cache is in-process (TTL bounded) — surviving sessions is not required
 * since the same problematic IDs tend to repeat within minutes, and a
 * cross-session cache lookup costs more than re-detecting on a miss.
 *
 * Reference: copilot-gateway responses/retry-connection-mismatch.ts
 */

const CACHE_TTL_MS = 3600_000

type AnyItem = Record<string, unknown>

interface ResponsesInputPayload {
  input?: unknown
}

const spotted = new Map<string, number>() // id -> expiry epoch ms

const now = (): number => Date.now()

function spotMark(id: string): void {
  spotted.set(id, now() + CACHE_TTL_MS)
}

function spotHas(id: string): boolean {
  const exp = spotted.get(id)
  if (exp === undefined) return false
  if (exp <= now()) {
    spotted.delete(id)
    return false
  }
  return true
}

function isBase64Id(id: string): boolean {
  if (id.length < 20) return false
  try {
    atob(id)
    return true
  } catch {
    return false
  }
}

async function sha256Hex16(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16)
}

async function deriveReplacementId(type: string, originalId: string): Promise<string> {
  const hex = await sha256Hex16(originalId)
  const prefix = type === "reasoning" ? "rs" : type === "function_call" ? "fc" : "msg"
  return `${prefix}_${hex}`
}

function getItems(payload: ResponsesInputPayload): AnyItem[] {
  return Array.isArray(payload.input) ? (payload.input as AnyItem[]) : []
}

function isItemReference(item: AnyItem): boolean {
  const type = item.type as string | undefined
  return type === "item_reference" || (typeof type === "string" && type.endsWith("_reference"))
}

/**
 * Apply known-bad-ID fixes to the payload in place. Returns true if anything
 * changed.
 */
export async function applySpottedConnectionFixes(
  payload: ResponsesInputPayload,
): Promise<boolean> {
  const items = getItems(payload)
  const withId = items.filter((it) => typeof it.id === "string" && Boolean(it.id))
  if (withId.length === 0) return false

  let changed = false
  const drop = new Set<string>()
  for (const item of withId) {
    const id = item.id as string
    if (!spotHas(id)) continue
    if (isItemReference(item)) {
      drop.add(id)
    } else {
      item.id = await deriveReplacementId((item.type as string) || "message", id)
    }
    changed = true
  }
  if (drop.size > 0) {
    payload.input = items.filter(
      (it) => !isItemReference(it) || !drop.has(it.id as string),
    ) as unknown as typeof payload.input
  }
  return changed
}

function collectBase64Ids(items: AnyItem[]): string[] {
  return items.flatMap((it) => {
    const id = it.id
    return typeof id === "string" && isBase64Id(id) ? [id] : []
  })
}

/**
 * Spot every base64-looking ID in the payload, then apply fixes. Returns
 * true if anything changed.
 */
export async function collectAndFixConnectionMismatch(
  payload: ResponsesInputPayload,
): Promise<boolean> {
  const items = getItems(payload)
  const base64Ids = collectBase64Ids(items)
  if (base64Ids.length === 0) return false
  for (const id of base64Ids) spotMark(id)
  await applySpottedConnectionFixes(payload)
  return true
}

export function isConnectionMismatchErrorBody(body: unknown): boolean {
  const message = (body as { error?: { message?: unknown } })?.error?.message
  return typeof message === "string"
    && message.toLowerCase().includes("does not belong to this connection")
}

/**
 * Wrap a `/responses` call with connection-mismatch pre-fix + on-error retry.
 *
 * `attempt(payload)` must perform exactly one upstream call and return the
 * Response. We may invoke it up to twice — the second time only after we
 * mutated `payload` to fix newly-spotted base64 IDs.
 *
 * The wrapper buffers the first response's body so it can inspect the error
 * payload before deciding whether to retry. On non-error or non-mismatch we
 * rebuild a fresh Response with the buffered body so the caller still gets a
 * streamable, fully-functional object.
 */
export async function withConnectionMismatchRetry(
  payload: ResponsesInputPayload,
  attempt: (payload: ResponsesInputPayload) => Promise<Response>,
): Promise<Response> {
  await applySpottedConnectionFixes(payload)
  const first = await attempt(payload)
  if (first.ok) return first

  // Buffer error body so we can read it AND optionally still return it.
  const errBytes = new Uint8Array(await first.arrayBuffer())
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(errBytes))
  } catch {
    return new Response(errBytes, {
      status: first.status,
      statusText: first.statusText,
      headers: first.headers,
    })
  }
  if (!isConnectionMismatchErrorBody(parsed)) {
    return new Response(errBytes, {
      status: first.status,
      statusText: first.statusText,
      headers: first.headers,
    })
  }

  const fixed = await collectAndFixConnectionMismatch(payload)
  if (!fixed) {
    return new Response(errBytes, {
      status: first.status,
      statusText: first.statusText,
      headers: first.headers,
    })
  }
  return await attempt(payload)
}

// Exposed for tests.
export const __test = {
  clearSpotted: () => spotted.clear(),
  spotMark,
  spotHas,
  isBase64Id,
}
