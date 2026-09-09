import { withBackground } from "@vibe-core/platform"
import { app } from "@vibe-llm/gateway"
import { bootstrapCloudflarePlatform, type CloudflareEnv } from "./bootstrap.ts"

export default {
  fetch(req: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    bootstrapCloudflarePlatform(env, ctx)
    return withBackground({ waitUntil: p => ctx.waitUntil(p) }, () => app.fetch(req, env, ctx))
  },
} satisfies ExportedHandler<CloudflareEnv>
