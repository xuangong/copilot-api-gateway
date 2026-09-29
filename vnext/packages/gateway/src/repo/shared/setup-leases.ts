import type { ApiKeyId, SetupLeaseId } from "../branded-ids.ts"
import type { SetupLease, SetupLeaseRepo } from "../types.ts"
import type { SqlExecutor } from "./executor.ts"

const columns = `token_hash AS tokenHash, id, minter_user_id AS minterUserId, key_id AS keyId,
  key_owner_id AS keyOwnerId, client, platform, settings_json AS settingsJson,
  configuration_revision AS configurationRevision, key_fingerprint AS keyFingerprint,
  artifact_digest AS artifactDigest, created_at AS createdAt, expires_at AS expiresAt,
  consumed_at AS consumedAt, revoked_at AS revokedAt`

export class SharedSetupLeaseRepo implements SetupLeaseRepo {
  constructor(private readonly x: SqlExecutor) {}

  async create(lease: SetupLease): Promise<void> {
    await this.x.run(`INSERT INTO setup_leases (
      token_hash, id, minter_user_id, key_id, key_owner_id, client, platform, settings_json,
      configuration_revision, key_fingerprint, artifact_digest, created_at, expires_at, consumed_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      lease.tokenHash, lease.id, lease.minterUserId, lease.keyId, lease.keyOwnerId, lease.client, lease.platform,
      lease.settingsJson, lease.configurationRevision, lease.keyFingerprint, lease.artifactDigest,
      lease.createdAt, lease.expiresAt, lease.consumedAt, lease.revokedAt,
    ])
  }

  findByTokenHash(tokenHash: string): Promise<SetupLease | null> {
    return this.x.first<SetupLease>(`SELECT ${columns} FROM setup_leases WHERE token_hash = ?`, [tokenHash])
  }

  findById(id: SetupLeaseId): Promise<SetupLease | null> {
    return this.x.first<SetupLease>(`SELECT ${columns} FROM setup_leases WHERE id = ?`, [id])
  }

  async revoke(id: SetupLeaseId, keyId: ApiKeyId, now: string): Promise<void> {
    await this.x.run("UPDATE setup_leases SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND key_id = ?", [now, id, keyId])
  }

  async consume(lease: SetupLease, rawKey: string, now: string, adminEmails: readonly string[]): Promise<boolean> {
    const admin = adminEmails.length ? `lower(minter.email) IN (${adminEmails.map(() => "?").join(",")})` : "0"
    const result = await this.x.run(`UPDATE setup_leases SET consumed_at = ?
      WHERE token_hash = ? AND id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
        AND minter_user_id = ? AND key_id = ? AND key_owner_id IS ?
        AND client = ? AND platform = ? AND settings_json = ?
        AND configuration_revision = ? AND key_fingerprint = ? AND artifact_digest = ?
        AND created_at = ? AND expires_at = ?
        AND configuration_revision = (SELECT revision FROM configuration_revision WHERE id = 1)
        AND EXISTS (
          SELECT 1 FROM api_keys AS selected
          JOIN users AS minter ON minter.id = setup_leases.minter_user_id
          LEFT JOIN users AS owner ON owner.id = selected.owner_id
          WHERE selected.id = setup_leases.key_id AND selected.key = ?
            AND selected.owner_id IS setup_leases.key_owner_id
            AND minter.disabled = 0 AND (selected.owner_id IS NULL OR owner.disabled = 0)
            AND (selected.owner_id = minter.id OR ${admin})
        )`, [
      now, lease.tokenHash, lease.id, now, lease.minterUserId, lease.keyId, lease.keyOwnerId,
      lease.client, lease.platform, lease.settingsJson, lease.configurationRevision, lease.keyFingerprint,
      lease.artifactDigest, lease.createdAt, lease.expiresAt, rawKey, ...adminEmails,
    ])
    return result.changes === 1
  }
}
