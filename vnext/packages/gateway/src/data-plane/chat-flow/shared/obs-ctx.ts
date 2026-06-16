/**
 * Standalone module for the observability context shape carried through the
 * data-plane chat-flow. Lifted out of `gateway-ctx.ts` (and re-exported from
 * legacy `dispatch.ts`) so callers can depend on this type without importing
 * the soon-to-be-deleted dispatch core.
 *
 * The shape mirrors what `readObsCtx(c, auth)` produces from a Hono request:
 *   - `apiKeyId` is undefined when the auth middleware did not authenticate the
 *     caller (anonymous tests bypass it).
 *   - `userAgent` / `requestId` are undefined when the inbound headers are
 *     absent. Persistence helpers normalise them to '<unknown>' / a fresh UUID.
 */
export interface DispatchObsCtx {
  apiKeyId: string | undefined
  userAgent: string | undefined
  requestId: string | undefined
}
