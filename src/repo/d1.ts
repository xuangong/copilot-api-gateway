import type { Repo } from "./types"
import type { SqlExecutor } from "./shared/executor"
import { buildSharedRepo } from "./shared/repos"

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
  }
}
