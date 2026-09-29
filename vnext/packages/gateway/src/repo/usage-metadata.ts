import type { ApiKeyId } from "./branded-ids"
import type { SqlExecutor } from "./shared/executor"
import type { UsageAssigneeMetadata, UsageKeyMetadata } from "./types"

export function queryUsageKeyMetadata(x: SqlExecutor, keyIds?: readonly ApiKeyId[]): Promise<UsageKeyMetadata[]> {
  return x.all<UsageKeyMetadata>(
    `SELECT k.id AS keyId, k.name AS keyName, NULLIF(k.owner_id, '') AS ownerId,
      u.name AS ownerName, k.created_at AS createdAt
     FROM api_keys k LEFT JOIN users u ON u.id = k.owner_id
     ${keyIds === undefined ? "" : "WHERE k.id IN (SELECT value FROM json_each(?))"}
     ORDER BY k.created_at`,
    keyIds === undefined ? [] : [JSON.stringify(keyIds)],
  )
}

export function queryUsageAssigneeMetadata(x: SqlExecutor, keyIds: readonly ApiKeyId[]): Promise<UsageAssigneeMetadata[]> {
  // The legacy per-key lookup walks the (key_id, user_id) primary-key index.
  // Retain that per-key order when combining all visible rosters in one read.
  return x.all<UsageAssigneeMetadata>(
    `SELECT a.key_id AS keyId, a.user_id AS userId, u.name AS name
     FROM key_assignments a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.key_id IN (SELECT value FROM json_each(?))
     ORDER BY a.key_id COLLATE BINARY, a.user_id COLLATE BINARY`,
    [JSON.stringify(keyIds)],
  )
}
