import type { Repo, SqlExecutor } from "@vibe-llm/gateway/repo"
import { buildSharedRepo } from "@vibe-llm/gateway/repo"

interface D1Result<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  meta: Record<string, unknown>
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
  // D1 executes batch statements atomically as one transaction.
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
}

async function d1HasColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT name FROM pragma_table_info(?) WHERE name = ?")
    .bind(table, column)
    .first<{ name: string }>()
  return row !== null
}

const usageIdentityColumns = "key_id, incoming_model, model, COALESCE(upstream, ''), model_key, client, hour, dimension"
const usageRequestsIdentityColumns = "key_id, incoming_model, model, COALESCE(upstream, ''), model_key, client, hour"

async function d1HasIdentityIndex(db: D1Database, name: string, columns: string): Promise<boolean> {
  const row = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").bind(name).first<{ sql: string }>()
  return row?.sql.replace(/\s+/g, " ").includes(columns) ?? false
}

async function d1HasCurrentUsageSchema(db: D1Database): Promise<boolean> {
  const [legacy, usageDimension, usageIncoming, requestsIncoming] = await Promise.all([
    d1HasColumn(db, "usage", "input_tokens"),
    d1HasColumn(db, "usage", "dimension"),
    d1HasColumn(db, "usage", "incoming_model"),
    d1HasColumn(db, "usage_requests", "incoming_model"),
  ])
  return !legacy && usageDimension && usageIncoming && requestsIncoming
}

async function ensureD1Column(db: D1Database, table: "usage" | "usage_requests"): Promise<void> {
  if (await d1HasColumn(db, table, "incoming_model")) return
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN incoming_model TEXT NOT NULL DEFAULT ''`).run()
  } catch (error) {
    if (!(await d1HasColumn(db, table, "incoming_model"))) throw error
  }
}

/**
 * Plan 6 schema bootstrap + in-place migration for D1.
 *
 * Production CFW deploys apply schema via wrangler's migrations_dir, but this
 * helper mirrors the SQLite init path so an embedding host can bring a D1
 * binding up-to-date programmatically. Each statement is issued individually
 * because D1's prepare() / run() does not support multi-statement scripts.
 */
export async function initD1(db: D1Database): Promise<void> {
  // Per-dimension usage tables (new shape).
  await db.prepare(`CREATE TABLE IF NOT EXISTS usage (
    key_id         TEXT NOT NULL,
    incoming_model TEXT NOT NULL DEFAULT '',
    model          TEXT NOT NULL,
    upstream       TEXT,
    model_key      TEXT NOT NULL,
    client         TEXT NOT NULL DEFAULT '',
    hour           TEXT NOT NULL,
    dimension      TEXT NOT NULL,
    tokens         INTEGER NOT NULL,
    unit_price     REAL
  )`).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage (hour)`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS usage_requests (
    key_id         TEXT NOT NULL,
    incoming_model TEXT NOT NULL DEFAULT '',
    model          TEXT NOT NULL,
    upstream       TEXT,
    model_key      TEXT NOT NULL,
    client         TEXT NOT NULL DEFAULT '',
    hour           TEXT NOT NULL,
    requests       INTEGER NOT NULL
  )`).run()
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_usage_requests_hour ON usage_requests (hour)`).run()

  // Plan 6 schema bootstrap + incoming-model migration. A D1 batch is an
  // atomic transaction, so a failed conversion leaves the legacy table intact.
  if (await d1HasColumn(db, "usage", "input_tokens")) {
    try {
      await db.batch([
        db.prepare(`CREATE TABLE usage_dims_new (
          key_id TEXT NOT NULL, incoming_model TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL,
          client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, dimension TEXT NOT NULL,
          tokens INTEGER NOT NULL, unit_price REAL
        )`),
        db.prepare(`CREATE TABLE usage_reqs_new (
          key_id TEXT NOT NULL, incoming_model TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL,
          client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, requests INTEGER NOT NULL
        )`),
        db.prepare(`INSERT INTO usage_reqs_new (key_id, incoming_model, model, upstream, model_key, client, hour, requests)
          SELECT key_id, '', model, upstream, model AS model_key, client, hour, requests FROM usage`),
        db.prepare(`INSERT INTO usage_dims_new (key_id, incoming_model, model, upstream, model_key, client, hour, dimension, tokens, unit_price)
          SELECT key_id, '', model, upstream, model, client, hour, 'input', input_tokens, NULL FROM usage WHERE input_tokens > 0
          UNION ALL SELECT key_id, '', model, upstream, model, client, hour, 'output', output_tokens, NULL FROM usage WHERE output_tokens > 0
          UNION ALL SELECT key_id, '', model, upstream, model, client, hour, 'input_cache_read', cache_read_tokens, NULL FROM usage WHERE cache_read_tokens > 0
          UNION ALL SELECT key_id, '', model, upstream, model, client, hour, 'input_cache_write', cache_creation_tokens, NULL FROM usage WHERE cache_creation_tokens > 0`),
        db.prepare(`DROP TABLE usage`),
        db.prepare(`DROP TABLE IF EXISTS usage_requests`),
        db.prepare(`ALTER TABLE usage_dims_new RENAME TO usage`),
        db.prepare(`ALTER TABLE usage_reqs_new RENAME TO usage_requests`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage (hour)`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_usage_requests_hour ON usage_requests (hour)`),
      ])
    } catch (error) {
      if (!(await d1HasCurrentUsageSchema(db))) throw error
    }
  } else {
    await ensureD1Column(db, "usage")
    await ensureD1Column(db, "usage_requests")
  }

  // The pair must change together: keep it in one D1 transaction.
  try {
    await db.batch([
      db.prepare(`DROP INDEX IF EXISTS idx_usage_identity`),
      db.prepare(`DROP INDEX IF EXISTS idx_usage_requests_identity`),
      db.prepare(`CREATE UNIQUE INDEX idx_usage_identity ON usage (${usageIdentityColumns})`),
      db.prepare(`CREATE UNIQUE INDEX idx_usage_requests_identity ON usage_requests (${usageRequestsIdentityColumns})`),
    ])
  } catch (error) {
    const [usageIdentity, requestsIdentity] = await Promise.all([
      d1HasIdentityIndex(db, "idx_usage_identity", usageIdentityColumns),
      d1HasIdentityIndex(db, "idx_usage_requests_identity", usageRequestsIdentityColumns),
    ])
    if (!usageIdentity || !requestsIdentity) throw error
  }
}

class D1Executor implements SqlExecutor {
  constructor(private db: D1Database) {}

  private prep(sql: string, binds: unknown[]): D1PreparedStatement {
    const s = this.db.prepare(sql)
    return binds.length > 0 ? s.bind(...binds) : s
  }

  async all<T = any>(sql: string, binds: unknown[]): Promise<T[]> {
    const { results } = await this.prep(sql, binds).all<T>()
    return results ?? []
  }

  async first<T = any>(sql: string, binds: unknown[]): Promise<T | null> {
    return await this.prep(sql, binds).first<T>()
  }

  async run(sql: string, binds: unknown[]): Promise<{ changes: number }> {
    const result = await this.prep(sql, binds).run()
    return { changes: (result.meta.changes as number) ?? 0 }
  }
}

export class D1Repo implements Repo {
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

  constructor(db: D1Database) {
    const shared = buildSharedRepo(new D1Executor(db))
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
