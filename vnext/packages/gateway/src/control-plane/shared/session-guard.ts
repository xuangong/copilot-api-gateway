import type { MiddlewareHandler } from "hono"
import { getRepo } from "../../repo/index.ts"
import type { SessionToken } from "../../repo/branded-ids.ts"
import type { FullAuthCtx } from "../../shared/credential-auth.ts"

const deny = (status: 401 | 403, code: string) => new Response(JSON.stringify({ error: { code } }), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
})

/**
 * Management routes for secrets and credentials: a real, current `ses_` session (not a legacy user key, not an
 * inference key, no query string), and a same-origin request. A cookie session must also carry `Origin` on mutating
 * methods, because browsers omit `Origin` on same-origin GET; a mismatched `Origin` is refused on every method.
 */
function browserSessionGuard(allowQuery: boolean): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth") as FullAuthCtx | undefined
    if (auth?.authKind !== "session" || !auth.userId || auth.apiKeyId) return deny(401, "session_required")
    const url = new URL(c.req.url)
    const headers = c.req.raw.headers
    const authorization = headers.get("authorization")
    const token = authorization !== null ? /^Bearer (ses_[^\s]+)$/i.exec(authorization)?.[1]
      : /(?:^|;\s*)session_token=(ses_[^\s;]+)/.exec(headers.get("cookie") ?? "")?.[1]
    const queryRefused = allowQuery ? url.searchParams.has("key") : url.search !== ""
    if (!token || token.length > 4096 || queryRefused || headers.has("x-api-key") || headers.has("x-goog-api-key")) {
      return deny(401, "session_required")
    }
    const origin = headers.get("origin")
    const mutating = c.req.method !== "GET" && c.req.method !== "HEAD"
    if ((origin !== null && origin !== url.origin) || (authorization === null && origin === null && mutating)) {
      return deny(403, "origin_not_allowed")
    }
    // Legacy user keys share authKind=session; require an actual, current session record.
    const session = await getRepo().sessions.findByToken(token as SessionToken)
    if (!session || session.userId !== auth.userId || !(Date.parse(session.expiresAt) > Date.now())) {
      return deny(401, "session_required")
    }
    await next()
  }
}

export const requireBrowserSession: MiddlewareHandler = browserSessionGuard(false)
/** The same rules for read-only views that take filters; a `key` query parameter is still refused. */
export const requireBrowserSessionAllowingQuery: MiddlewareHandler = browserSessionGuard(true)
