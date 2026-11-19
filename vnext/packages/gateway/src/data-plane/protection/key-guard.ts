import type { MiddlewareHandler } from 'hono'
import { isInferencePath } from '../inference-paths.ts'
import { getProtection } from '../../protection/runtime.ts'
import { pausedBody } from '../errors/upstream-paused.ts'
import { keyPausedMessage } from '../../protection/messages.ts'

/** The error protocol of the path, ignoring compatibility prefixes. */
function errorFormat(requestPath: string): 'gemini' | 'anthropic' | undefined {
  const path = requestPath.replace(/^\/(?:azure-api\.codex|engines\/(?:[^/]+\/)?v1|anthropic)(?=\/)/, '')
  // `/v1/models` alone is the OpenAI listing; anything below it is Gemini's model route.
  if (/^\/v1beta\/models(?:\/|$)/.test(path) || /^\/v1\/models\/.+/.test(path)) return 'gemini'
  if (/^(?:\/v1)?\/messages(?:\/count_tokens)?$/.test(path)) return 'anthropic'
  return undefined
}

/**
 * A paused API key gets `503 key_paused` with `Retry-After` on every request, before any upstream is called.
 * Only model-facing paths of API-key requests are checked: the key-only dashboard and control-plane routes stay open so the holder can see why, and dashboard sessions (which resume keys) pass. A cache refresh
 * failure is fail-open (the runtime never throws).
 */
export const keyPausedMiddleware: MiddlewareHandler = async (c, next) => {
  const auth = c.get('auth' as never) as { apiKeyId?: string } | undefined
  if (auth?.apiKeyId && isInferencePath(c.req.path)) {
    const runtime = getProtection()
    const pause = await runtime.pausedKey(auth.apiKeyId)
    if (pause) {
      const { message, retryAfterSeconds } = keyPausedMessage(pause, runtime.now())
      return c.json(pausedBody('key_paused', message, errorFormat(c.req.path)) as object, 503, { 'Retry-After': String(retryAfterSeconds) })
    }
  }
  await next()
}
