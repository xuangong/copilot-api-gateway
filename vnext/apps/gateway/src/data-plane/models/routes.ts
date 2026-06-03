/**
 * Models data-plane router — Week 5a-impl port of old src/routes/models.ts.
 *
 * Three routes preserved 1:1:
 *   - GET /api/models         — dashboard endpoint; gracefully empty when no upstream
 *   - GET /models             — SDK probe; 404 JSON when empty AND no per-request copilot token
 *   - GET /v1/models          — same as /models
 *
 * vnext shape delta: old project threw `new Error("GitHub token not found...")` and let the
 * outer Elysia error mapper turn it into 5xx. vnext returns an explicit 404 JSON so the
 * client sees a stable shape; SDK consumers treat 404 the same as the old 5xx text.
 *
 * Auth context: caller-supplied via `c.get('auth')` carrying optional `userId` +
 * `copilot` ({copilotToken, accountType}); registry handles the request-scoped fallback.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { listUpstreamModels, type CreateProviderOptions } from '../providers/registry.ts'

export interface DataPlaneAuthCtx {
  userId?: string
  copilot?: CreateProviderOptions
  /** API-key id authenticated for this request; required for per-key web-search/quota lookups. */
  apiKeyId?: string
  /** GitHub OAuth token attached to the request (used by Copilot web-search engine). */
  githubToken?: string
  /** Env-derived Microsoft Grounding key, surfaced via auth ctx so handlers don't reach into env directly. */
  msGroundingKey?: string
}

type Vars = { auth: DataPlaneAuthCtx }

export const modelsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

modelsRouter.get('/api/models', async (c) => {
  const auth = c.get('auth') ?? {}
  return c.json(await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot }))
})

async function handleList(auth: DataPlaneAuthCtx) {
  const models = await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot })
  if (!models.data.length && !auth.copilot?.copilotToken) {
    return { ok: false, models } as const
  }
  return { ok: true, models } as const
}

modelsRouter.get('/models', async (c) => {
  const result = await handleList(c.get('auth') ?? {})
  if (!result.ok) {
    return c.json(
      { error: { type: 'invalid_request_error', message: 'GitHub token not found. Use /auth/github to connect your account.' } },
      404,
    )
  }
  return c.json(result.models)
})

modelsRouter.get('/v1/models', async (c) => {
  const result = await handleList(c.get('auth') ?? {})
  if (!result.ok) {
    return c.json(
      { error: { type: 'invalid_request_error', message: 'GitHub token not found. Use /auth/github to connect your account.' } },
      404,
    )
  }
  return c.json(result.models)
})
