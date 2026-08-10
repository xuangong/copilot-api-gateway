// Thin async SQL adapter so D1 and bun:sqlite can share a single set of repo
// implementations. Backends implement these three methods; everything else
// lives in shared/repos.ts.

export interface SqlExecutor {
  all<T = any>(sql: string, binds: unknown[]): Promise<T[]>
  first<T = any>(sql: string, binds: unknown[]): Promise<T | null>
  run(sql: string, binds: unknown[]): Promise<{ changes: number }>
}
