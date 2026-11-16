// Client-side validation mirroring `parseLokiMirrorDocument` in @vibe-llm/provider-loki; the server re-validates.
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

/** The normalized origin of an HTTPS origin-only address, or null. Mirrors the server's rules. */
function httpsOrigin(value: string): string | null {
  if (/[?#]/.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" ? url.origin : null
  } catch { return null }
}

/** Returns the document with a normalized origin, or null when invalid. */
function validDocument(value: unknown): LokiMirrorDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const doc = value as Record<string, unknown>
  if (Object.keys(doc).some(key => !KEYS.includes(key)) || doc.version !== 1 || doc.kind !== "loki-mirror"
    || doc.profileId !== "loki-df-v1" || typeof doc.gatewayOrigin !== "string"
    || typeof doc.upstreamId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(doc.upstreamId)
    || typeof doc.mirrorId !== "string" || !/^lkmid_[a-f0-9]{32}$/.test(doc.mirrorId)
    || typeof doc.mirrorSecret !== "string" || !/^lkm_[a-f0-9]{64}$/.test(doc.mirrorSecret)) return null
  const origin = httpsOrigin(doc.gatewayOrigin)
  return origin ? { ...(doc as unknown as LokiMirrorDocument), gatewayOrigin: origin } : null
}

/** Formats a freshly issued document, refusing one that names another gateway. */
export function formatLokiMirrorDocument(value: unknown, expectedOrigin: string): string {
  const doc = validDocument(value)
  if (!doc || doc.gatewayOrigin !== httpsOrigin(expectedOrigin)) throw new Error("Invalid mirror document")
  const { version, kind, gatewayOrigin, upstreamId, profileId, mirrorId, mirrorSecret } = doc
  return JSON.stringify({ version, kind, gatewayOrigin, upstreamId, profileId, mirrorId, mirrorSecret }, null, 2)
}

/** Parses pasted text; the server re-validates. */
export function parseLokiMirrorText(text: string): LokiMirrorDocument | null {
  try {
    return validDocument(JSON.parse(text.trim()))
  } catch { return null }
}
