import { Database } from "bun:sqlite"

import type { Repo, SqlExecutor } from "@vibe-llm/gateway/repo"
import { buildSharedRepo } from "@vibe-llm/gateway/repo"
import { applyMigrations } from "./migrate.ts"

/**
 * Brings `db` up to the current schema. The SQL corpus in
 * `packages/gateway/migrations/` is the single source of truth: Wrangler
 * applies the same files to D1, so both runtimes converge on one definition.
 */
export function initSqlite(db: Database): void {
  applyMigrations(db)
}

class SqliteExecutor implements SqlExecutor {
  constructor(private db: Database) {}

  async all<T = any>(sql: string, binds: unknown[]): Promise<T[]> {
    return this.db.query(sql).all(...(binds as any[])) as T[]
  }

  async first<T = any>(sql: string, binds: unknown[]): Promise<T | null> {
    return (this.db.query(sql).get(...(binds as any[])) ?? null) as T | null
  }

  async run(sql: string, binds: unknown[]): Promise<{ changes: number }> {
    const r = this.db.query(sql).run(...(binds as any[]))
    return { changes: Number(r.changes) || 0 }
  }
}

export class BunSqliteRepo implements Repo {
  apiKeys: Repo["apiKeys"]
  github: Repo["github"]
  upstreams: Repo["upstreams"]
  usage: Repo["usage"]
  cache: Repo["cache"]
  latency: Repo["latency"]
  performance: Repo["performance"]
  users: Repo["users"]
  inviteCodes: Repo["inviteCodes"]
  sessions: Repo["sessions"]
  presence: Repo["presence"]
  webSearchUsage: Repo["webSearchUsage"]
  webSearchEngineUsage: Repo["webSearchEngineUsage"]
  keyAssignments: Repo["keyAssignments"]
  observabilityShares: Repo["observabilityShares"]
  deviceCodes: Repo["deviceCodes"]
  responsesItems: Repo["responsesItems"]
  proxies: Repo["proxies"]
  proxyBackoffs: Repo["proxyBackoffs"]

  constructor(db: Database) {
    initSqlite(db)
    const shared = buildSharedRepo(new SqliteExecutor(db))
    this.apiKeys = shared.apiKeys
    this.github = shared.github
    this.upstreams = shared.upstreams
    this.usage = shared.usage
    this.cache = shared.cache
    this.latency = shared.latency
    this.performance = shared.performance
    this.users = shared.users
    this.inviteCodes = shared.inviteCodes
    this.sessions = shared.sessions
    this.presence = shared.presence
    this.webSearchUsage = shared.webSearchUsage
    this.webSearchEngineUsage = shared.webSearchEngineUsage
    this.keyAssignments = shared.keyAssignments
    this.observabilityShares = shared.observabilityShares
    this.deviceCodes = shared.deviceCodes
    this.responsesItems = shared.responsesItems
    this.proxies = shared.proxies
    this.proxyBackoffs = shared.proxyBackoffs
  }
}

export function createSqliteDb(path: string): Database {
  return new Database(path)
}
