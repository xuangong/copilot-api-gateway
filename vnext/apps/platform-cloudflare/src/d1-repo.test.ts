import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { initD1, type D1Database } from "./d1-repo.ts"

type SqliteBind = string | number | bigint | boolean | null | Uint8Array

interface StatementState {
  query: string
  binds: SqliteBind[]
}

class SqliteD1Adapter implements D1Database {
  private readonly states = new WeakMap<object, StatementState>()
  batches: string[][] = []
  private failed = false

  constructor(private readonly db: Database, private readonly failBatchStatement?: number) {}

  prepare(query: string): ReturnType<D1Database["prepare"]> {
    const state: StatementState = { query, binds: [] }
    const statement: ReturnType<D1Database["prepare"]> = {
      bind: (...values) => {
        const binds: SqliteBind[] = []
        for (const value of values) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value === null || value instanceof Uint8Array) binds.push(value)
          else throw new TypeError("unsupported SQLite bind")
        }
        state.binds = binds
        return statement
      },
      first: async <T>() => (this.db.query(state.query).get(...state.binds) ?? null) as T | null,
      all: async <T>() => ({ results: this.db.query(state.query).all(...state.binds) as T[], success: true, meta: {} }),
      run: async () => {
        const result = this.db.query(state.query).run(...state.binds)
        return { results: [], success: true, meta: { changes: Number(result.changes) } }
      },
    }
    this.states.set(statement, state)
    return statement
  }

  async batch<T = unknown>(statements: ReturnType<D1Database["prepare"]>[]): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }[]> {
    const states = statements.map((statement) => {
      const state = this.states.get(statement)
      if (state === undefined) throw new TypeError("unknown D1 statement")
      return state
    })
    this.batches.push(states.map((state) => state.query))
    this.db.exec("BEGIN")
    try {
      for (const [index, state] of states.entries()) {
        if (!this.failed && this.failBatchStatement === index) {
          this.failed = true
          throw new Error("injected D1 batch failure")
        }
        this.db.query(state.query).run(...state.binds)
      }
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    return []
  }
}

const createLegacyUsage = (db: Database): void => {
  db.exec(`CREATE TABLE usage (
    key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0
  )`)
}

const indexSql = (db: Database, name: string): string | undefined =>
  db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)?.sql.replace(/\s+/g, " ")

const tempTables = (db: Database): string[] =>
  db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'usage_%_new'").all().map((row) => row.name)

describe("initD1", () => {
  test("creates a fresh schema without ALTERs and atomically creates both identities", async () => {
    const db = new Database(":memory:")
    try {
      const d1 = new SqliteD1Adapter(db)
      await initD1(d1)

      expect(db.query<{ name: string; notnull: number; dflt_value: string | null }, []>(`SELECT name, "notnull", dflt_value FROM pragma_table_info('usage') WHERE name = 'incoming_model'`).get()).toEqual({ name: "incoming_model", notnull: 1, dflt_value: "''" })
      expect(d1.batches).toHaveLength(1)
      expect(d1.batches[0]?.map((sql) => sql.replace(/\s+/g, " ").trim())).toEqual([
        "DROP INDEX IF EXISTS idx_usage_identity",
        "DROP INDEX IF EXISTS idx_usage_requests_identity",
        "CREATE UNIQUE INDEX idx_usage_identity ON usage (key_id, incoming_model, model, COALESCE(upstream, ''), model_key, client, hour, dimension)",
        "CREATE UNIQUE INDEX idx_usage_requests_identity ON usage_requests (key_id, incoming_model, model, COALESCE(upstream, ''), model_key, client, hour)",
      ])
      await initD1(d1)
    } finally {
      db.close()
    }
  })

  test("converts legacy usage atomically and preserves paired unknown data", async () => {
    const db = new Database(":memory:")
    try {
      createLegacyUsage(db)
      db.exec(`INSERT INTO usage (key_id, model, upstream, client, hour, input_tokens, output_tokens, requests) VALUES ('key', 'model', 'up', 'curl', 'hour', 11, 7, 3)`)
      const d1 = new SqliteD1Adapter(db)

      await initD1(d1)

      expect(d1.batches).toHaveLength(2)
      expect(d1.batches[0]).toHaveLength(10)
      expect(db.query<{ incomingModel: string; dimension: string; tokens: number }, []>("SELECT incoming_model AS incomingModel, dimension, tokens FROM usage ORDER BY dimension").all()).toEqual([
        { incomingModel: "", dimension: "input", tokens: 11 },
        { incomingModel: "", dimension: "output", tokens: 7 },
      ])
      expect(db.query<{ incomingModel: string; modelKey: string; requests: number }, []>("SELECT incoming_model AS incomingModel, model_key AS modelKey, requests FROM usage_requests").get()).toEqual({ incomingModel: "", modelKey: "model", requests: 3 })
      expect(tempTables(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  test("rolls back a failed legacy batch without temp tables or data loss, then retries", async () => {
    const db = new Database(":memory:")
    try {
      createLegacyUsage(db)
      db.exec(`INSERT INTO usage (key_id, model, upstream, client, hour, input_tokens, requests) VALUES ('key', 'model', 'up', 'curl', 'hour', 11, 3)`)
      const failing = new SqliteD1Adapter(db, 3)

      await expect(initD1(failing)).rejects.toThrow("injected D1 batch failure")
      expect(db.query<{ inputTokens: number; requests: number }, []>("SELECT input_tokens AS inputTokens, requests FROM usage").get()).toEqual({ inputTokens: 11, requests: 3 })
      expect(tempTables(db)).toEqual([])
      expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM usage_requests").get()).toEqual({ count: 0 })

      await initD1(new SqliteD1Adapter(db))
      expect(db.query<{ tokens: number }, []>("SELECT tokens FROM usage WHERE dimension = 'input'").get()).toEqual({ tokens: 11 })
    } finally {
      db.close()
    }
  })

  test("rolls back a failed identity batch and leaves old indexes intact", async () => {
    const db = new Database(":memory:")
    try {
      db.exec(`
        CREATE TABLE usage (key_id TEXT NOT NULL, incoming_model TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, dimension TEXT NOT NULL, tokens INTEGER NOT NULL, unit_price REAL);
        CREATE TABLE usage_requests (key_id TEXT NOT NULL, incoming_model TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, requests INTEGER NOT NULL);
        CREATE UNIQUE INDEX idx_usage_identity ON usage (key_id, model, COALESCE(upstream, ''), model_key, client, hour, dimension);
        CREATE UNIQUE INDEX idx_usage_requests_identity ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, client, hour);
      `)
      await expect(initD1(new SqliteD1Adapter(db, 2))).rejects.toThrow("injected D1 batch failure")
      expect(indexSql(db, "idx_usage_identity")).toContain("key_id, model, COALESCE(upstream, ''), model_key")
      expect(indexSql(db, "idx_usage_requests_identity")).toContain("key_id, model, COALESCE(upstream, ''), model_key")
    } finally {
      db.close()
    }
  })

  test("upgrades both existing per-dimension tables and is repeatable", async () => {
    const db = new Database(":memory:")
    try {
      db.exec(`
        CREATE TABLE usage (key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, dimension TEXT NOT NULL, tokens INTEGER NOT NULL, unit_price REAL);
        CREATE TABLE usage_requests (key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, requests INTEGER NOT NULL);
        INSERT INTO usage VALUES ('key', 'model', 'up', 'provider', 'curl', 'hour', 'input', 5, 1.5);
        INSERT INTO usage_requests VALUES ('key', 'model', 'up', 'provider', 'curl', 'hour', 2);
      `)
      const d1 = new SqliteD1Adapter(db)

      await initD1(d1)
      await initD1(d1)

      expect(db.query<{ incomingModel: string; tokens: number }, []>("SELECT incoming_model AS incomingModel, tokens FROM usage").get()).toEqual({ incomingModel: "", tokens: 5 })
      expect(db.query<{ incomingModel: string; requests: number }, []>("SELECT incoming_model AS incomingModel, requests FROM usage_requests").get()).toEqual({ incomingModel: "", requests: 2 })
      expect(indexSql(db, "idx_usage_identity")).toContain("key_id, incoming_model, model, COALESCE(upstream, ''), model_key")
    } finally {
      db.close()
    }
  })
})
