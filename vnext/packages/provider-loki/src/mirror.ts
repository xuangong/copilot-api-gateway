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

export type LokiMirrorPull = LokiMirrorPullOutcome | { kind: "unavailable" } | { kind: "failed" }

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
  try {
    if (response.status !== 200 && response.status !== 503) return response.status === 401 ? { kind: "revoked" } : { kind: "failed" }
    const length = Number(response.headers.get("content-length") ?? 0)
    if (length > MAX_BODY) return { kind: "failed" }
    const raw = await response.text()
    if (raw.length > MAX_BODY) return { kind: "failed" }
    const body = JSON.parse(raw) as Record<string, unknown> | null
    if (response.status === 503) {
      const code = (body?.error as { code?: unknown } | undefined)?.code
      return code === "credential_unavailable" ? { kind: "unavailable" } : { kind: "failed" }
    }
    if (!body || body.version !== 1 || body.profileId !== LOKI_PROFILE_ID || body.mirrorId !== source.mirrorId) return { kind: "failed" }
    const credential = parseLokiCredential(body.credential)
    return credential.expiresAt > now + LOKI_MIN_CREDENTIAL_TTL_MS ? { kind: "ok", credential } : { kind: "failed" }
  } catch { return { kind: "failed" } }
  finally { if (!response.bodyUsed) await response.body?.cancel().catch(() => {}) }
}
