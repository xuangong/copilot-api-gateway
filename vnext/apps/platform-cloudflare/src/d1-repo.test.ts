import { describe, expect, test } from "bun:test"
import { initD1, type D1Database } from "./d1-repo.ts"

interface RecordedStatement {
  sql: string
  binds: unknown[]
}

class StatementRecorder {
  readonly statements: RecordedStatement[] = []
  private readonly tablesCreated: boolean

  constructor(private readonly columns: Set<string>, tablesCreated = true) {
    this.tablesCreated = tablesCreated
  }

  database(): D1Database {
    return {
      prepare: (sql) => {
        const statement: RecordedStatement = { sql, binds: [] }
        this.statements.push(statement)
        const prepared: ReturnType<D1Database["prepare"]> = {
          bind: (...values) => {
            statement.binds = values
            return prepared
          },
          first: async <T>() => {
            const [, column] = statement.binds
            return (typeof column === "string" && this.columns.has(column) ? { name: column } : null) as T | null
          },
          all: async () => ({ results: [], success: true, meta: {} }),
          run: async () => {
            if (!this.tablesCreated && sql.startsWith("CREATE TABLE IF NOT EXISTS usage") && !this.columns.has("input_tokens")) {
              this.columns.add("incoming_model")
            }
            return { results: [], success: true, meta: {} }
          },
        }
        return prepared
      },
    }
  }
}

const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim()
const rawSqls = (recorder: StatementRecorder) => recorder.statements.map((statement) => statement.sql)

const sqls = (recorder: StatementRecorder) => recorder.statements.map((statement) => normalized(statement.sql))

describe("initD1", () => {
  test("creates fresh usage tables with incoming model columns and identities", async () => {
    const recorder = new StatementRecorder(new Set(), false)

    await initD1(recorder.database())

    expect(sqls(recorder)).toContain(
      "CREATE TABLE IF NOT EXISTS usage ( key_id TEXT NOT NULL, incoming_model TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, dimension TEXT NOT NULL, tokens INTEGER NOT NULL, unit_price REAL )",
    )
    expect(sqls(recorder)).toContain(
      "CREATE TABLE IF NOT EXISTS usage_requests ( key_id TEXT NOT NULL, incoming_model TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, requests INTEGER NOT NULL )",
    )
    expect(sqls(recorder)).toContain(
      "CREATE UNIQUE INDEX idx_usage_identity ON usage (key_id, incoming_model, model, COALESCE(upstream, ''), model_key, client, hour, dimension)",
    )
    expect(sqls(recorder)).toContain(
      "CREATE UNIQUE INDEX idx_usage_requests_identity ON usage_requests (key_id, incoming_model, model, COALESCE(upstream, ''), model_key, client, hour)",
    )
  })

  test("upgrades both existing per-dimension tables missing incoming model", async () => {
    const recorder = new StatementRecorder(new Set(["dimension"]))

    await initD1(recorder.database())

    expect(rawSqls(recorder)).toContain("ALTER TABLE usage ADD COLUMN incoming_model TEXT NOT NULL DEFAULT ''")
    expect(rawSqls(recorder)).toContain("ALTER TABLE usage_requests ADD COLUMN incoming_model TEXT NOT NULL DEFAULT ''")
    expect(sqls(recorder)).toContain("DROP INDEX IF EXISTS idx_usage_identity")
    expect(sqls(recorder)).toContain("DROP INDEX IF EXISTS idx_usage_requests_identity")
  })

  test("converts legacy usage through incoming-aware temporary tables", async () => {
    const recorder = new StatementRecorder(new Set(["input_tokens"]))

    await initD1(recorder.database())

    const statements = sqls(recorder)
    expect(statements).toContain(
      "CREATE TABLE usage_dims_new ( key_id TEXT NOT NULL, incoming_model TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, dimension TEXT NOT NULL, tokens INTEGER NOT NULL, unit_price REAL )",
    )
    expect(statements).toContain(
      "CREATE TABLE usage_reqs_new ( key_id TEXT NOT NULL, incoming_model TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, requests INTEGER NOT NULL )",
    )
    expect(
      statements.some((sql) => sql.includes("INSERT INTO usage_reqs_new (key_id, incoming_model, model, upstream, model_key, client, hour, requests)") && sql.includes("SELECT key_id, '', model")),
    ).toBe(true)
    expect(
      statements.some((sql) => sql.includes("INSERT INTO usage_dims_new (key_id, incoming_model, model, upstream, model_key, client, hour, dimension, tokens, unit_price)") && sql.includes("SELECT key_id, '', model")),
    ).toBe(true)
    expect(statements).toContain("DROP INDEX IF EXISTS idx_usage_identity")
    expect(statements).toContain("DROP INDEX IF EXISTS idx_usage_requests_identity")
  })
})
