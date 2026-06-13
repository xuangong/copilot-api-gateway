// Local Bun runtime entry. Uses bun:sqlite as the backing store so the full
// route surface (control-plane + data-plane) works without Cloudflare bindings.
//
// CFW-only bindings that aren't simulated here (KV / IMAGES / R2 / IMAGE_CACHE)
// are wired as `null` shims — any route that touches them will throw and is
// expected to fail locally. Plain JSON / SSE routes that only hit the repo
// run end-to-end against the local sqlite file.
import { Database } from 'bun:sqlite'
import { app } from './src/app.ts'
import { SqliteRepo } from './src/shared/repo/sqlite.ts'
import { initRepo } from './src/shared/repo/index.ts'
import { initCache } from './src/shared/cache/index.ts'
import { createCacheFromEnv } from './src/shared/cache/factory.ts'

const dbPath = process.env.VNEXT_DB_PATH ?? '.vnext-local.sqlite'
const db = new Database(dbPath)
initRepo(new SqliteRepo(db))
initCache(createCacheFromEnv({ /* no CFW bindings under bun */ }, process.env))

const port = Number(process.env.PORT ?? 8788)
const env = {
  DB: null as never,        // unused locally — SqliteRepo serves all reads/writes
  KV: null as never,
  IMAGE_CACHE: null as never,
  IMAGES: null as never,
  ACCOUNT_TYPE: process.env.ACCOUNT_TYPE ?? 'individual',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
}

Bun.serve({
  port,
  fetch: (req) => app.fetch(req, env as never),
})

// eslint-disable-next-line no-console
console.log(`vnext gateway (bun) listening on http://localhost:${port}`)
// eslint-disable-next-line no-console
console.log(`  sqlite file: ${dbPath}`)
