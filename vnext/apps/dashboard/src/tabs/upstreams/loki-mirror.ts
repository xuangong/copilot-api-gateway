export interface LokiMirrorDocument {
  version: 1
  kind: "loki-mirror"
  gatewayOrigin: string
  upstreamId: string
  profileId: "loki-df-v1"
  mirrorId: string
  mirrorSecret: string
}

export interface LokiMirrorRow { id: string; label: string; createdAt: number; lastPulledAt: number | null }

const KEYS = ["version", "kind", "gatewayOrigin", "upstreamId", "profileId", "mirrorId", "mirrorSecret"]

function validDocument(value: unknown): value is LokiMirrorDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const doc = value as Record<string, unknown>
  if (Object.keys(doc).some(key => !KEYS.includes(key)) || doc.version !== 1 || doc.kind !== "loki-mirror"
    || doc.profileId !== "loki-df-v1" || typeof doc.gatewayOrigin !== "string"
    || typeof doc.upstreamId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(doc.upstreamId)
    || typeof doc.mirrorId !== "string" || !/^lkmid_[a-f0-9]{32}$/.test(doc.mirrorId)
    || typeof doc.mirrorSecret !== "string" || !/^lkm_[a-f0-9]{64}$/.test(doc.mirrorSecret)) return false
  try {
    const url = new URL(doc.gatewayOrigin)
    return url.protocol === "https:" && url.origin === doc.gatewayOrigin
  } catch { return false }
}

/** Formats a freshly issued document, refusing one that names another gateway. */
export function formatLokiMirrorDocument(value: unknown, expectedOrigin: string): string {
  if (!validDocument(value) || value.gatewayOrigin !== expectedOrigin) throw new Error("Invalid mirror document")
  const { version, kind, gatewayOrigin, upstreamId, profileId, mirrorId, mirrorSecret } = value
  return JSON.stringify({ version, kind, gatewayOrigin, upstreamId, profileId, mirrorId, mirrorSecret }, null, 2)
}

/** Parses pasted text; the server re-validates. */
export function parseLokiMirrorText(text: string): LokiMirrorDocument | null {
  try {
    const value: unknown = JSON.parse(text.trim())
    return validDocument(value) ? value : null
  } catch { return null }
}
