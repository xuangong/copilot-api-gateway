/**
 * TEMPORARY residual: bridges `entry-bun.ts` (which still passes a raw
 * `bun:sqlite.Database`) to the relocated factory at
 * `apps/platform-bun/src/responses-store-factory.ts` (which now takes the
 * runtime-neutral `BunSqliteDatabase` adapter). Wraps the raw db in the
 * adapter before delegating, preserving the old call signature so callers
 * don't need to change yet.
 *
 * T6 rewrites `entry-bun` to live inside `apps/platform-bun/` and call the
 * new factory directly with a BunSqliteDatabase. T9 deletes this residual.
 *
 * Why a relative path: gateway cannot workspace-depend on platform-bun
 * without creating a circular workspace dep, so the `@vnext/platform-bun`
 * subpath strategy used by platform-cloudflare in T3 doesn't apply in
 * this direction.
 *
 * DO NOT add new code here.
 */
import type { Database } from "bun:sqlite"
import type { ResponsesSnapshotStore } from "@vnext/responses-store"
import { BunSqliteDatabase } from "../../../../../apps/platform-bun/src/bun-sqlite-database.ts"
import { createBunResponsesStore as createFromAdapter } from "../../../../../apps/platform-bun/src/responses-store-factory.ts"

export function createBunResponsesStore(db: Database): ResponsesSnapshotStore {
  return createFromAdapter(new BunSqliteDatabase(db))
}
