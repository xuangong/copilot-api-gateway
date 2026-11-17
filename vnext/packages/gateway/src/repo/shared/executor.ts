// Thin async SQL adapter so D1 and bun:sqlite can share a single set of repo
// implementations. Backends implement `all`, `first` and `run` (plus an optional
// `batch`, which telemetry requires); everything else lives in shared/repos.ts.

export interface SqlStatement {
  sql: string
  binds: unknown[]
}

export interface SqlExecutor {
  all<T = any>(sql: string, binds: unknown[]): Promise<T[]>
  first<T = any>(sql: string, binds: unknown[]): Promise<T | null>
  run(sql: string, binds: unknown[]): Promise<{ changes: number }>
  /** Runs the statements in order as one transaction: any failure rolls all of them back. Optional; telemetry requires it. */
  batch?(statements: readonly SqlStatement[]): Promise<{ changes: number }[]>
}
