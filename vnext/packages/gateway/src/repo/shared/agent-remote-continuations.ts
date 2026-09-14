import type { AgentRemoteContinuation, AgentRemoteContinuationRepo, UserSession } from "../types.ts"
import type { UserId } from "../branded-ids.ts"
import type { SqlExecutor } from "./executor.ts"

export class SharedAgentRemoteContinuationRepo implements AgentRemoteContinuationRepo {
  constructor(private readonly sql: SqlExecutor) {}

  async createOAuthState(stateHash: string, browserHash: string, returnPath: string, now: number): Promise<boolean> {
    await this.sql.run("DELETE FROM agent_remote_oauth_states WHERE expires_at <= ?", [now])
    const result = await this.sql.run(`INSERT INTO agent_remote_oauth_states (state_hash, browser_hash, return_path, expires_at)
      SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM agent_remote_oauth_states) < 1024`, [stateHash, browserHash, returnPath, now + 600_000])
    return result.changes === 1
  }

  async consumeOAuthState(stateHash: string, browserHash: string, now: number): Promise<string | null> {
    const row = await this.sql.first<{ return_path: string }>(`DELETE FROM agent_remote_oauth_states
      WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING return_path`, [stateHash, browserHash, now])
    return row?.return_path ?? null
  }

  async create(value: AgentRemoteContinuation, session: UserSession): Promise<boolean> {
    const now = Date.now()
    await this.sql.run("DELETE FROM agent_remote_continuations WHERE expires_at <= ?", [now])
    await this.sql.run("UPDATE user_sessions SET agent_remote_id = ? WHERE token = ? AND agent_remote_id IS NULL", [crypto.randomUUID(), session.token])
    // Admission and session binding happen in one SQL statement on both Bun and D1.
    const result = await this.sql.run(`INSERT INTO agent_remote_continuations
      (handle_hash, session_id, user_id, issuer, audience, expires_at, authenticated_at)
      SELECT ?, agent_remote_id, user_id, ?, ?, ?, ? FROM user_sessions
      WHERE token = ? AND user_id = ? AND created_at = ? AND expires_at = ?
      AND (SELECT COUNT(*) FROM agent_remote_continuations WHERE user_id = ?) < 128`,
    [value.handleHash, value.issuer, value.audience, value.expiresAt, value.authenticatedAt,
      session.token, session.userId, session.createdAt, session.expiresAt, session.userId])
    return result.changes === 1
  }

  async findActive(handleHash: string, issuer: string, audience: string, now: number) {
    const row = await this.sql.first<{
      user_id: UserId; expires_at: number; authenticated_at: number; session_expires_at: string; session_created_at: string
    }>(`SELECT c.user_id, c.expires_at, c.authenticated_at,
        s.expires_at AS session_expires_at, s.created_at AS session_created_at
      FROM agent_remote_continuations c JOIN user_sessions s ON s.agent_remote_id = c.session_id
      WHERE c.handle_hash = ? AND c.issuer = ? AND c.audience = ? AND c.user_id = s.user_id AND c.expires_at > ?`,
    [handleHash, issuer, audience, now])
    if (!row || Date.parse(row.session_created_at) !== row.authenticated_at || row.authenticated_at > now || row.authenticated_at <= 0) return null
    const expiresAt = Math.min(row.expires_at, Date.parse(row.session_expires_at))
    return expiresAt > now ? { subject: row.user_id, expiresAt, authenticatedAt: row.authenticated_at } : null
  }
}
