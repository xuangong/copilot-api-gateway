import {
  __resetPlatformForTests,
  initImageProcessor,
  initEnv,
  initBackground,
  initRuntimeLocation,
  initSqlDatabase,
  type SqlDatabase,
} from '@vnext/platform'
import { Database } from 'bun:sqlite'
import { MemoryCache } from '@vnext/cache'
import { InMemoryResponsesSnapshotStore } from '@vnext/responses-store'
import { initRepo } from '../src/shared/repo/index.ts'
import { initCache } from '../src/shared/cache/index.ts'
import { initResponsesStore } from '../src/shared/runtime/responses-store.ts'
import { BunSqliteRepo as SqliteRepo } from '@vnext/platform-bun/src/bun-sqlite-repo.ts'
import { createInMemoryImageProcessor } from '@vnext/platform-bun/src/memory-image-processor.ts'

export interface SetupOptions {
  envLookup?: (name: string) => string
}

export function setupTestPlatform(opts: SetupOptions = {}): {
  db: Database
  repo: SqliteRepo
} {
  __resetPlatformForTests()
  const db = new Database(':memory:')
  const repo = new SqliteRepo(db)
  initSqlDatabase(db as unknown as SqlDatabase)
  initEnv(opts.envLookup ?? (() => ''))
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
  initImageProcessor(createInMemoryImageProcessor())
  initRepo(repo)
  initCache(new MemoryCache())
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  return { db, repo }
}
