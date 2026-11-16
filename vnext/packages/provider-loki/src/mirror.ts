import type { Fetcher } from "@vibe-core/upstream"
import { LOKI_PROFILE_ID } from "./profile"
import { LOKI_MIN_CREDENTIAL_TTL_MS, LokiSyncError, parseLokiCredential, parseLokiMirrorSource, type LokiMirrorPullOutcome, type LokiMirrorSource } from "./state"

export interface LokiMirrorDocument {
  version: 1
  kind: "loki-mirror"
  gatewayOrigin: string
  upstreamId: string
  profileId: typeof LOKI_PROFILE_ID
  mirrorId: string
  mirrorSecret: string
}

/** Non-ok results carry the HTTP status when a response was received. */
export type LokiMirrorPull = Extract<LokiMirrorPullOutcome, { kind: "ok" }>
  | { kind: "revoked"; status?: number } | { kind: "unavailable"; status?: number } | { kind: "failed"; status?: number }

const MAX_BODY = 16_384
const DOCUMENT_KEYS = ["version", "kind", "gatewayOrigin", "upstreamId", "profileId", "mirrorId", "mirrorSecret"]

export function lokiMirrorDocument(gatewayOrigin: string, upstreamId: string, mirrorId: string, mirrorSecret: string): LokiMirrorDocument {
  return { version: 1, kind: "loki-mirror", gatewayOrigin, upstreamId, profileId: LOKI_PROFILE_ID, mirrorId, mirrorSecret }
}

export function parseLokiMirrorDocument(value: unknown): LokiMirrorSource {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    const doc = value as Record<string, unknown>
    if (Object.keys(doc).some(key => !DOCUMENT_KEYS.includes(key)) || doc.version !== 1
      || doc.kind !== "loki-mirror" || doc.profileId !== LOKI_PROFILE_ID) throw new Error()
    return parseLokiMirrorSource({ kind: "mirror", origin: doc.gatewayOrigin, upstreamId: doc.upstreamId,
      mirrorId: doc.mirrorId, mirrorSecret: doc.mirrorSecret })
  } catch { throw new LokiSyncError("invalid_mirror_document", 400) }
}

/** One pull from the central gateway. Never throws; never follows redirects. */
export async function pullLokiMirror(source: LokiMirrorSource, fetcher: Fetcher, now = Date.now()): Promise<LokiMirrorPull> {
  let response: Response
  try {
    response = await fetcher(`${source.origin}/api/loki/mirror/${encodeURIComponent(source.upstreamId)}`, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${source.mirrorSecret}`, accept: "application/json" },
    })
  } catch { return { kind: "failed" } }
  const { status } = response
  const failed = { kind: "failed" as const, status }
  try {
    if (status !== 200 && status !== 503) return status === 401 ? { kind: "revoked", status } : failed
    const length = Number(response.headers.get("content-length") ?? 0)
    if (length > MAX_BODY) return failed
    const raw = await readBounded(response)
    if (raw === undefined) return failed
    const body = JSON.parse(raw) as Record<string, unknown> | null
    if (status === 503) {
      const code = (body?.error as { code?: unknown } | undefined)?.code
      return code === "credential_unavailable" ? { kind: "unavailable", status } : failed
    }
    if (!body || body.version !== 1 || body.profileId !== LOKI_PROFILE_ID || body.mirrorId !== source.mirrorId) return failed
    const credential = parseLokiCredential(body.credential)
    return credential.expiresAt > now + LOKI_MIN_CREDENTIAL_TTL_MS ? { kind: "ok", credential } : failed
  } catch { return failed }
  finally { if (!response.bodyUsed) await response.body?.cancel().catch(() => {}) }
}

/** Reads the body while enforcing MAX_BODY; cancels the stream and returns undefined when exceeded. */
async function readBounded(response: Response): Promise<string | undefined> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) { await reader.cancel().catch(() => {}); return undefined }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}
