import { getFileProvider } from "@vibe-core/platform"
import { sweepMaintenance } from "@vibe-llm/gateway/maintenance"
import { app } from "@vibe-llm/gateway"
import { bootstrapBunPlatform } from "./bootstrap.ts"
import { createResponsesWebSocketHandlers } from "./responses-websocket.ts"

const dbPath = process.env.VNEXT_DB_PATH ?? ".vnext-local.sqlite"
const { db } = bootstrapBunPlatform({
  dbPath,
  cacheBackend: process.env.CACHE_BACKEND,
})

let sweeping = false
const sweep = async () => {
  if (sweeping) return
  sweeping = true
  try {
    await sweepMaintenance(db, getFileProvider(), Date.now())
  } catch {
    console.warn(JSON.stringify({ evt: "maintenance_sweep_failed" }))
  } finally {
    sweeping = false
  }
}
void sweep()
setInterval(() => { void sweep() }, 60_000).unref()

// Docker compose sets PORT=41414; bare local runs fall back to 8788.
const port = Number(process.env.PORT ?? 8788)
Bun.serve({
  port,
  // Bun's default is 10s and the idle timer keeps running while a response is
  // streaming, so a model that thinks quietly gets its connection reset
  // mid-answer. 255 is the documented maximum.
  idleTimeout: 255,
  ...createResponsesWebSocketHandlers({ app }),
})
console.log(`vnext gateway (bun) listening on http://localhost:${port}`)
console.log(`  sqlite file: ${dbPath}`)
