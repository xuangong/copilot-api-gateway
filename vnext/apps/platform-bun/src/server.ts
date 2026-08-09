import { app } from "@vibe-llm/gateway/src/app.ts"
import { bootstrapBunPlatform } from "./bootstrap.ts"

const dbPath = process.env.VNEXT_DB_PATH ?? ".vnext-local.sqlite"
bootstrapBunPlatform({
  dbPath,
  cacheBackend: process.env.CACHE_BACKEND,
})

// Docker compose sets PORT=41415; bare local runs fall back to 8788.
const port = Number(process.env.PORT ?? 8788)
Bun.serve({
  port,
  // Bun's default is 10s and the idle timer keeps running while a response is
  // streaming, so a model that thinks quietly gets its connection reset
  // mid-answer. 255 is the documented maximum.
  idleTimeout: 255,
  fetch: (req, server) => {
    // Even 255s is short for a long-thinking upstream (300s+ of silence has
    // been measured), so drop the timer entirely on the data plane.
    if (new URL(req.url).pathname.startsWith("/v1/")) server.timeout(req, 0)
    return app.fetch(req)
  },
})
console.log(`vnext gateway (bun) listening on http://localhost:${port}`)
console.log(`  sqlite file: ${dbPath}`)
