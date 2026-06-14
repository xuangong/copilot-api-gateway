// Local Bun runtime entry. Synchronously wires every platform + gateway-internal
// seam before serving any request, then starts Bun.serve.
//
// CFW-only bindings (KV / IMAGES / R2 / IMAGE_CACHE) aren't simulated here.
// Routes touching them throw — expected when running locally without bindings.
import { Database } from 'bun:sqlite'
import {
  initSqlDatabase,
  initImageProcessor,
  initEnv,
  initBackground,
  type SqlDatabase,
} from '@vnext/platform'
import { app } from './src/app.ts'
import { SqliteRepo } from './src/shared/repo/sqlite.ts'
import { initRepo } from './src/shared/repo/index.ts'
import { initCache } from './src/shared/cache/index.ts'
import { createCacheFromEnv } from './src/shared/cache/factory.ts'
import { createInMemoryImageProcessor } from './src/shared/image/memory.ts'
import { initResponsesStore } from './src/shared/runtime/responses-store.ts'
import { createBunResponsesStore } from './src/shared/runtime/responses-store-factory.ts'

const dbPath = process.env.VNEXT_DB_PATH ?? '.vnext-local.sqlite'
const sqliteDb = new Database(dbPath)

initSqlDatabase(sqliteDb as unknown as SqlDatabase)
initEnv((name) => process.env[name] ?? '')
initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
initImageProcessor(createInMemoryImageProcessor())
initRepo(new SqliteRepo(sqliteDb))
initCache(createCacheFromEnv({ /* no CFW bindings under bun */ }, process.env))
initResponsesStore(createBunResponsesStore(sqliteDb))

const port = Number(process.env.PORT ?? 8788)

Bun.serve({
  port,
  fetch: (req) => app.fetch(req),
})

// eslint-disable-next-line no-console
console.log(`vnext gateway (bun) listening on http://localhost:${port}`)
// eslint-disable-next-line no-console
console.log(`  sqlite file: ${dbPath}`)
