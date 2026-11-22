import type { DataPlaneAuthCtx } from "../../models/routes.ts"
import { deriveSessionInput, newBalanceSession, type BalanceProtocol } from "../../../quota-balance/session-key.ts"

/**
 * Called by the HTTP handlers right after the body is parsed (before any interceptor can strip `prompt_cache_key`): attaches the request's
 * session identity for quota balancing. Cheap string work only; the hash is computed later and only when the request meets a group.
 */
export function withBalanceSession<A extends DataPlaneAuthCtx>(auth: A, protocol: BalanceProtocol, raw: unknown, headers: Headers | undefined): A {
  try {
    return { ...auth, balanceSession: newBalanceSession(deriveSessionInput(protocol, raw, headers, auth.apiKeyId ?? auth.userId ?? "")) }
  } catch { return auth }
}
