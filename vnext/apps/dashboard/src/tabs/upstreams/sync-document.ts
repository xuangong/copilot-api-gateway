// Client-side validation mirroring `parseSyncDocument` in the gateway; the server re-validates.
import type { SyncDocument } from "../../api/sync"

const KEYS = ["version", "kind", "gatewayOrigin", "deviceId", "deviceSecret"]

/** The normalized origin of a bare HTTPS origin, or null. Mirrors the server's rules. */
export function httpsOrigin(value: string): string | null {
  if (/[?#\s\\]/.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" ? url.origin : null
  } catch { return null }
}

function validDocument(value: unknown): SyncDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const doc = value as Record<string, unknown>
  if (Object.keys(doc).some(key => !KEYS.includes(key)) || doc.version !== 1 || doc.kind !== "gateway-sync"
    || typeof doc.gatewayOrigin !== "string" || typeof doc.deviceId !== "string" || !/^sdv_[a-f0-9]{32}$/.test(doc.deviceId)
    || typeof doc.deviceSecret !== "string" || !/^sds_[a-f0-9]{64}$/.test(doc.deviceSecret)) return null
  const origin = httpsOrigin(doc.gatewayOrigin)
  return origin ? { version: 1, kind: "gateway-sync", gatewayOrigin: origin, deviceId: doc.deviceId, deviceSecret: doc.deviceSecret } : null
}

/** Parses pasted text; null when it is not a valid document. */
export function parseSyncDocumentText(text: string): SyncDocument | null {
  try { return validDocument(JSON.parse(text.trim())) } catch { return null }
}

/** Formats a freshly issued document, refusing one that names another gateway. */
export function formatSyncDocument(value: unknown, expectedOrigin: string): string {
  const doc = validDocument(value)
  if (!doc || doc.gatewayOrigin !== httpsOrigin(expectedOrigin)) throw new Error("Invalid sync document")
  return JSON.stringify(doc, null, 2)
}

/**
 * Formats a just-issued document. When it names another gateway it can never be used, so the new device is revoked at once
 * (`revoke` is the DELETE call) rather than left behind; `revoked` is false when that cleanup itself failed.
 */
export async function presentIssuedDocument<D>(
  issued: { device: { id: string }; document: unknown }, expectedOrigin: string,
  revoke: (deviceId: string) => Promise<{ devices: D[] }>,
): Promise<{ kind: "shown"; text: string } | { kind: "mismatch"; revoked: true; devices: D[] } | { kind: "mismatch"; revoked: false }> {
  try { return { kind: "shown", text: formatSyncDocument(issued.document, expectedOrigin) } } catch { /* mismatch */ }
  try { return { kind: "mismatch", revoked: true, devices: (await revoke(issued.device.id)).devices } }
  catch { return { kind: "mismatch", revoked: false } }
}
