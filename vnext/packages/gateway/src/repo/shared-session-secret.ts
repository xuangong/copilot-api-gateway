import type { ApiKeyId, UserId } from "./branded-ids"
import type { SqlExecutor } from "./shared/executor"

export interface SharedSessionConfig { readonly enabled: boolean; readonly secret: string | null }
export function normalizeSharedSessionSecret(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value.trim()) ? value.trim().toLowerCase() : null
}
export async function getSharedSessionConfig(x: SqlExecutor, id: ApiKeyId, ownerId: UserId): Promise<SharedSessionConfig | null> {
  const row = await x.first<{ shared_session_enabled: number; shared_session_secret: string | null }>(
    "SELECT shared_session_enabled, shared_session_secret FROM api_keys WHERE id=? AND owner_id=?", [id, ownerId])
  if (!row) return null
  if (row.shared_session_secret !== null && normalizeSharedSessionSecret(row.shared_session_secret) !== row.shared_session_secret) throw new Error("Invalid persisted shared session secret")
  if (row.shared_session_enabled !== 0 && row.shared_session_enabled !== 1) throw new Error("Invalid persisted shared session setting")
  if (row.shared_session_enabled === 1 && row.shared_session_secret === null) throw new Error("Missing shared session secret")
  return { enabled: row.shared_session_enabled === 1, secret: row.shared_session_secret }
}
export async function setSharedSessionConfig(x: SqlExecutor, id: ApiKeyId, ownerId: UserId, config: { enabled: boolean; secret?: string }): Promise<boolean> {
  if (typeof config.enabled !== "boolean" || (config.secret !== undefined && !normalizeSharedSessionSecret(config.secret))) throw new TypeError("Invalid shared session configuration")
  const secret = config.secret === undefined ? null : normalizeSharedSessionSecret(config.secret)
  const result = await x.run(`UPDATE api_keys SET shared_session_enabled=?, shared_session_secret=COALESCE(?,shared_session_secret)
    WHERE id=? AND owner_id=? AND (?=0 OR COALESCE(?,shared_session_secret) IS NOT NULL)`,
  [config.enabled ? 1 : 0, secret, id, ownerId, config.enabled ? 1 : 0, secret])
  return result.changes > 0
}
