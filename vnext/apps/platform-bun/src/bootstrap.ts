import { Database } from "bun:sqlite"
import {
  initSqlDatabase,
  initEnv,
  initBackground,
  initRuntimeLocation,
  initImageProcessor,
  initFileProvider,
  initSocketDial,
} from "@vibe-core/platform"
import { bunSocketDial } from "./bun-socket-dial.ts"
import { initRepo } from "@vibe-llm/gateway/repo"
import {
  initCache,
  initResponsesStore,
  initDumpBroker,
  initDumpStore,
  FileDumpStore,
  dumpCodec,
  EventTargetChannelBroker,
} from "@vibe-llm/gateway/bootstrap"
import { BunSqliteDatabase } from "./bun-sqlite-database.ts"
import { BunSqliteRepo } from "./bun-sqlite-repo.ts"
import { createInMemoryImageProcessor } from "./memory-image-processor.ts"
import { createBunCache } from "./cache-factory.ts"
import { FsFileProvider } from "./fs-file-provider.ts"
import { InMemoryResponsesSnapshotStore } from "@vibe-llm/responses-store"

export interface BunPlatformOptions {
  dbPath: string
  cacheBackend?: string
  /** Root directory for dump body storage. Defaults to `./data/files`. */
  filesRoot?: string
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
  initSocketDial(bunSocketDial)
  const files = new FsFileProvider(opts.filesRoot ?? './data/files')
  initFileProvider(files)
  initRepo(new BunSqliteRepo(sqliteDb))
  initCache(createBunCache({ db, backend: opts.cacheBackend }))
  // In-memory snapshot store: SQLite-backed store requires responses_snapshots
  // migration that hasn't shipped in the Bun runtime. In-memory keeps
  // previous_response_id chains working for the current container lifetime;
  // persistence revisited once the schema migration lands.
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  // Dump subsystem (Spec 14). FileDumpStore reads from SqlDatabase +
  // FileProvider (both just initialized); broker is in-process, one worker
  // per container per Bun deploy.
  initDumpStore(new FileDumpStore(db, files))
  initDumpBroker(new EventTargetChannelBroker(dumpCodec))
  _booted = true
  return { db }
}
