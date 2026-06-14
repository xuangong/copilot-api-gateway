/**
 * TEMPORARY: relocated to @vnext/platform-bun in plan A3 T4. This re-export
 * keeps gateway tests building until T9 rewires every consumer to import from
 * `@vnext/platform-bun/src/bun-sqlite-repo.ts` directly, at which point this
 * residual file is deleted.
 *
 * Why a relative path: gateway cannot workspace-depend on platform-bun
 * (platform-bun depends on gateway), so the @vnext/platform-bun subpath
 * import strategy used by platform-cloudflare in T3 doesn't work in this
 * direction. Walk back up to the workspace root, then down into the apps/
 * tree.
 *
 * `SqliteRepo` is an alias for `BunSqliteRepo` — the class was renamed in
 * T7 to follow its file name. Tests still import `SqliteRepo`; that goes
 * away in T9.
 */
export { BunSqliteRepo, BunSqliteRepo as SqliteRepo, initSqlite, createSqliteDb } from "../../../../../apps/platform-bun/src/bun-sqlite-repo.ts"
