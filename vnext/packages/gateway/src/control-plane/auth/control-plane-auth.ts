import type { MiddlewareHandler } from "hono"
import type { FullAuthCtx } from "../../shared/credential-auth.ts"

/** Data-plane ownership is routing scope, never a user management grant. */
export function projectControlPlaneAuth(auth: FullAuthCtx | undefined): FullAuthCtx | undefined {
  if (!auth || (!auth.apiKeyId && auth.authKind !== "apiKey")) return auth
  return {
    authKind: "apiKey",
    apiKeyId: auth.apiKeyId,
    routingPolicy: auth.routingPolicy,
    responsesRetentionSeconds: auth.responsesRetentionSeconds,
  }
}

export const controlPlaneAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const auth = c.get("auth") as FullAuthCtx | undefined
  if (auth) c.set("auth", projectControlPlaneAuth(auth))
  await next()
}
