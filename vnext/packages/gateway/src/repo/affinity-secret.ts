import type { ApiKeyId, UserId } from "./branded-ids.ts"
import type { SqlExecutor } from "./shared/executor.ts"

/** Private key material. Never attach to ApiKey, request context DTOs or logs. */
export interface ApiKeyAffinitySecret {
  readonly version: 1
  readonly keyId: string
  readonly secret: Uint8Array
}

export async function getOrCreateAffinitySecret(x: SqlExecutor, id: ApiKeyId, ownerId: UserId | undefined): Promise<ApiKeyAffinitySecret | null> {
  // Legacy ownerless keys retain raw behavior; no shared fallback identity exists.
  if (ownerId === undefined) return null
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("")
  await x.run(`UPDATE api_keys SET affinity_secret = ?, affinity_key_id = ?, affinity_version = 1
    WHERE id = ? AND owner_id = ? AND affinity_secret IS NULL AND affinity_key_id IS NULL AND affinity_version IS NULL`,
  [secret, crypto.randomUUID(), id, ownerId])
  const row = await x.first<{ affinity_secret: string | null; affinity_key_id: string | null; affinity_version: number | null }>(
    "SELECT affinity_secret, affinity_key_id, affinity_version FROM api_keys WHERE id = ? AND owner_id = ?", [id, ownerId])
  if (!row) return null
  if (row.affinity_version !== 1 || typeof row.affinity_secret !== "string" || !/^[0-9a-f]{64}$/.test(row.affinity_secret)
    || typeof row.affinity_key_id !== "string" || !/^[0-9a-f-]{36}$/.test(row.affinity_key_id)) throw new Error("Invalid persisted affinity key")
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(row.affinity_secret.slice(i * 2, i * 2 + 2), 16)
  return { version: 1, keyId: row.affinity_key_id, secret: bytes }
}
