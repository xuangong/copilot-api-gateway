import { Database } from "bun:sqlite"
import {
  initSqlDatabase,
  initEnv,
  initBackground,
  initRuntimeLocation,
  initImageProcessor,
} from "@vibe-core/platform"
import { initRepo } from "@vibe-llm/gateway/src/shared/repo/index.ts"
import { initCache } from "@vibe-llm/gateway/src/shared/cache/index.ts"
import { initResponsesStore } from "@vibe-llm/gateway/src/shared/runtime/responses-store.ts"
import { BunSqliteDatabase } from "./bun-sqlite-database.ts"
import { BunSqliteRepo } from "./bun-sqlite-repo.ts"
import { createInMemoryImageProcessor } from "./memory-image-processor.ts"
import { createBunCache } from "./cache-factory.ts"
import { InMemoryResponsesSnapshotStore } from "@vibe-llm/responses-store"

export interface BunPlatformOptions {
  dbPath: string
  cacheBackend?: string
}

let _booted = false

export function bootstrapBunPlatform(opts: BunPlatformOptions): { db: BunSqliteDatabase } {
  if (_booted) throw new Error("bootstrapBunPlatform already called")
  const sqliteDb = new Database(opts.dbPath)
  const db = new BunSqliteDatabase(sqliteDb)

  initSqlDatabase(db)
  initEnv((name) => process.env[name] ?? "")
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
  initImageProcessor(createInMemoryImageProcessor())
  initRepo(new BunSqliteRepo(sqliteDb))
  initCache(createBunCache({ db, backend: opts.cacheBackend }))
  // In-memory snapshot store: SQLite-backed store requires responses_snapshots
  // migration that hasn't shipped in the Bun runtime. In-memory keeps
  // previous_response_id chains working for the current container lifetime;
  // persistence revisited once the schema migration lands.
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  _booted = true
  return { db }
}
