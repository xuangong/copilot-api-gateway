import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { initD1, type D1Database } from "./d1-repo.ts"

type SqliteBind = string | number | bigint | boolean | null | Uint8Array

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

const createLegacyUsage = (db: Database) => {
  db.exec(`
    CREATE TABLE usage (
      key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0
    );
  `)
}

class SqliteD1Adapter implements D1Database {
  constructor(private readonly db: Database) {}

  prepare(query: string): ReturnType<D1Database["prepare"]> {
    let binds: SqliteBind[] = []
    const statement: ReturnType<D1Database["prepare"]> = {
      bind: (...values) => {
        const sqliteBinds: SqliteBind[] = []
        for (const value of values) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value === null || value instanceof Uint8Array) {
            sqliteBinds.push(value)
          } else {
            throw new TypeError("unsupported SQLite bind")
          }
        }
        binds = sqliteBinds
        return statement
      },
      first: async <T>() => (this.db.query(query).get(...binds) ?? null) as T | null,
      all: async <T>() => ({ results: this.db.query(query).all(...binds) as T[], success: true, meta: {} }),
      run: async () => {
        const result = this.db.query(query).run(...binds)
        return { results: [], success: true, meta: { changes: Number(result.changes) } }
      },
    }
    return statement
  }
}

describe("initD1", () => {
  test("executes fresh schema creation with incoming columns and correct identities", async () => {
    const db = new Database(":memory:")
    try {
      await initD1(new SqliteD1Adapter(db))

      expect(db.query<{ name: string; notnull: number; dflt_value: string | null }, []>(`SELECT name, "notnull", dflt_value FROM pragma_table_info('usage') WHERE name = 'incoming_model'`).get()).toEqual({
        name: "incoming_model",
        notnull: 1,
        dflt_value: "''",
      })
      expect(db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get("idx_usage_identity")?.sql.replace(/\s+/g, " ")).toContain(
        "key_id, incoming_model, model, COALESCE(upstream, ''), model_key, client, hour, dimension",
      )
      await initD1(new SqliteD1Adapter(db))
    } finally {
      db.close()
    }
  })

  test("executes existing per-dimension upgrade without changing existing values", async () => {
    const db = new Database(":memory:")
    try {
      db.exec(`
        CREATE TABLE usage (key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, dimension TEXT NOT NULL, tokens INTEGER NOT NULL, unit_price REAL);
        CREATE TABLE usage_requests (key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, requests INTEGER NOT NULL);
        CREATE UNIQUE INDEX idx_usage_identity ON usage (key_id, model, COALESCE(upstream, ''), model_key, client, hour, dimension);
        CREATE UNIQUE INDEX idx_usage_requests_identity ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, client, hour);
        INSERT INTO usage VALUES ('key', 'model', 'up', 'provider', 'curl', 'hour', 'input', 5, 1.5);
        INSERT INTO usage_requests VALUES ('key', 'model', 'up', 'provider', 'curl', 'hour', 2);
      `)

      await initD1(new SqliteD1Adapter(db))

      expect(db.query<{ incomingModel: string; tokens: number }, []>("SELECT incoming_model AS incomingModel, tokens FROM usage").get()).toEqual({ incomingModel: "", tokens: 5 })
      expect(db.query<{ incomingModel: string; requests: number }, []>("SELECT incoming_model AS incomingModel, requests FROM usage_requests").get()).toEqual({ incomingModel: "", requests: 2 })
      await initD1(new SqliteD1Adapter(db))
    } finally {
      db.close()
    }
  })

  test("executes legacy conversion with unknown incoming model and paired data", async () => {
    const db = new Database(":memory:")
    try {
      createLegacyUsage(db)
      db.exec(`INSERT INTO usage (key_id, model, upstream, client, hour, input_tokens, output_tokens, requests) VALUES ('key', 'model', 'up', 'curl', 'hour', 11, 7, 3)`)

      await initD1(new SqliteD1Adapter(db))

      expect(db.query<{ incomingModel: string; dimension: string; tokens: number }, []>("SELECT incoming_model AS incomingModel, dimension, tokens FROM usage ORDER BY dimension").all()).toEqual([
        { incomingModel: "", dimension: "input", tokens: 11 },
        { incomingModel: "", dimension: "output", tokens: 7 },
      ])
      expect(db.query<{ incomingModel: string; modelKey: string; requests: number }, []>("SELECT incoming_model AS incomingModel, model_key AS modelKey, requests FROM usage_requests").get()).toEqual({
        incomingModel: "",
        modelKey: "model",
        requests: 3,
      })
      await initD1(new SqliteD1Adapter(db))
    } finally {
      db.close()
    }
  })

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
