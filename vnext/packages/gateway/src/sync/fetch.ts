import { directFetcher, type Fetcher } from "@vibe-core/upstream"
import { SYNC_FETCH_TIMEOUT_MS, SYNC_MAX_SNAPSHOT_BYTES, parseSyncSnapshot, type SyncSnapshot } from "./protocol"

export interface SnapshotSource {
  origin: string
  deviceId: string
  secret: string
  etag: string | null
}

export type SnapshotFetch =
  | { kind: "changed"; snapshot: SyncSnapshot; etag: string }
  | { kind: "not_modified" }
  | { kind: "revoked" }
  | { kind: "failed"; code: "unreachable" | "http_error" | "bad_response" }

/** Reads at most `max` bytes; cancels the stream and returns null when the body is larger. */
async function readBounded(response: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

const SYNC_MAX_ERROR_BYTES = 4096

/** Only central's explicit `{"error":{"code":"invalid_device"}}` proves the device was revoked; a proxy or older central's bare 401 does not. */
async function isInvalidDevice(response: Response): Promise<boolean> {
  try {
    const bytes = await readBounded(response, SYNC_MAX_ERROR_BYTES)
    if (!bytes) return false
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { error?: { code?: unknown } } | null
    return body?.error?.code === "invalid_device"
  } catch { return false }
}

async function quotedSha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return `"${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}"`
}

/**
 * One poll of the central gateway. Direct fetch (never an upstream's proxy chain), no redirects, 15 s timeout, body capped
 * at 1 MiB while streaming. Never throws. The returned ETag is the hash of the bytes received, not the response header.
 */
export async function fetchSnapshot(source: SnapshotSource, fetcher: Fetcher = directFetcher): Promise<SnapshotFetch> {
  let response: Response
  try {
    response = await fetcher(`${source.origin}/api/sync/snapshot`, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
      headers: { authorization: `Bearer ${source.secret}`, accept: "application/json", ...(source.etag ? { "if-none-match": source.etag } : {}) },
    })
  } catch { return { kind: "failed", code: "unreachable" } }
  const bad = { kind: "failed" as const, code: "bad_response" as const }
  try {
    const { status } = response
    if (status === 401) return (await isInvalidDevice(response)) ? { kind: "revoked" } : { kind: "failed", code: "http_error" }
    if (status === 304) return source.etag ? { kind: "not_modified" } : bad
    if (status !== 200) return { kind: "failed", code: "http_error" }
    if (Number(response.headers.get("content-length") ?? 0) > SYNC_MAX_SNAPSHOT_BYTES) return bad
    const bytes = await readBounded(response, SYNC_MAX_SNAPSHOT_BYTES)
    if (!bytes) return bad
    const snapshot = parseSyncSnapshot(new TextDecoder("utf-8", { fatal: true }).decode(bytes), source.deviceId)
    return { kind: "changed", snapshot, etag: await quotedSha256(bytes) }
  } catch (error) {
    const name = (error as { name?: string } | null)?.name
    return name === "TimeoutError" || name === "AbortError" ? { kind: "failed", code: "unreachable" } : bad
  }
  finally { if (!response.bodyUsed) await response.body?.cancel().catch(() => {}) }
}
