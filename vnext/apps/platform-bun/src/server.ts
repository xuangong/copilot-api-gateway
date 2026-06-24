import { app } from "@vnext-llm/gateway/src/app.ts"
import { bootstrapBunPlatform } from "./bootstrap.ts"

const dbPath = process.env.VNEXT_DB_PATH ?? ".vnext-local.sqlite"
bootstrapBunPlatform({
  dbPath,
  cacheBackend: process.env.CACHE_BACKEND,
})

// Docker compose sets PORT=41415; bare local runs fall back to 8788.
const port = Number(process.env.PORT ?? 8788)
Bun.serve({ port, fetch: app.fetch })
console.log(`vnext gateway (bun) listening on http://localhost:${port}`)
console.log(`  sqlite file: ${dbPath}`)
