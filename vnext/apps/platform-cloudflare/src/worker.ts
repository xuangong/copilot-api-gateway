import { getFileProvider, getSqlDatabase } from "@vibe-core/platform"
import { sweepMaintenance } from "@vibe-llm/gateway/maintenance"
import { app } from "@vibe-llm/gateway"
import { bootstrapCloudflarePlatform, type CloudflareEnv } from "./bootstrap.ts"
import { createResponsesWebSocketHandler } from "./responses-websocket.ts"

const fetch = createResponsesWebSocketHandler({ app })

export default {
  async scheduled(event: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    bootstrapCloudflarePlatform(env, ctx)
    await sweepMaintenance(getSqlDatabase(), getFileProvider(), event.scheduledTime)
  },
  fetch(req: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    bootstrapCloudflarePlatform(env, ctx)
    return fetch(req, env, ctx)
  },
} satisfies ExportedHandler<CloudflareEnv>
