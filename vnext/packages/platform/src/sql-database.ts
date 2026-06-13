import { __registerPlatformReset } from "./reset.ts"

export interface SqlResultMeta {
  changes?: number
}
export interface SqlResult<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  meta: SqlResultMeta
}
export interface SqlPreparedStatement {
  bind(...values: unknown[]): SqlPreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>
  run(): Promise<SqlResult>
}
export interface SqlDatabase {
  prepare(query: string): SqlPreparedStatement
  batch?(stmts: SqlPreparedStatement[]): Promise<SqlResult[]>
  exec(sql: string): Promise<unknown>
}

let _db: SqlDatabase | null = null
__registerPlatformReset(() => { _db = null })

export function initSqlDatabase(db: SqlDatabase): void {
  _db = db
}

export function getSqlDatabase(): SqlDatabase {
  if (!_db) throw new Error("SqlDatabase not initialized; call bootstrap*Platform() first")
  return _db
}
