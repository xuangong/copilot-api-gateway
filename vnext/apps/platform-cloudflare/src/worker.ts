import { app } from "@vnext/gateway/src/app.ts"
import { bootstrapCloudflarePlatform, type CloudflareEnv } from "./bootstrap.ts"

export default {
  fetch(req: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    bootstrapCloudflarePlatform(env, ctx)
    return app.fetch(req, env, ctx)
  },
} satisfies ExportedHandler<CloudflareEnv>
