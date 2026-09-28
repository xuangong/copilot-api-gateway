import { getFileProvider, getSqlDatabase, withBackground } from "@vibe-core/platform"
import { sweepMaintenance } from "@vibe-llm/gateway/maintenance"
import { app } from "@vibe-llm/gateway"
import { bootstrapCloudflarePlatform, type CloudflareEnv } from "./bootstrap.ts"

export default {
  async scheduled(event: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    bootstrapCloudflarePlatform(env, ctx)
    await sweepMaintenance(getSqlDatabase(), getFileProvider(), event.scheduledTime)
  },
  fetch(req: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    bootstrapCloudflarePlatform(env, ctx)
    return withBackground({ waitUntil: p => ctx.waitUntil(p) }, () => app.fetch(req, env, ctx))
  },
} satisfies ExportedHandler<CloudflareEnv>
