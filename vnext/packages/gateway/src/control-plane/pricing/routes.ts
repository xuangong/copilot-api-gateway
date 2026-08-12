/**
 * pricing control-plane router — GET /api/pricing.
 *
 * Static: the published per-token price tables live in the provider packages,
 * so this handler does no repo or upstream I/O and cannot fail from an
 * unreachable upstream. The response is shaped as a list of providers so
 * adding codex / claude-code later is additive on both sides.
 */
import { Hono } from 'hono'
import { copilotPricingCatalog } from '@vibe-llm/provider-copilot'
import type { Env } from '../../app.ts'
import type { ApiKeyId, UserId } from '../../repo/branded-ids.ts'

interface PricingAuthCtx {
  isAdmin?: boolean
  userId?: UserId
  apiKeyId?: ApiKeyId
}

type Vars = { auth: PricingAuthCtx }

export const pricingRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

pricingRouter.get('/pricing', (c) => {
  // The figures themselves are public, but every sibling control-plane route
  // gates on a resolved identity and the tab is registered `userOk: true`.
  // Staying consistent also avoids advertising which models this gateway serves.
  const auth = c.get('auth') ?? {}
  if (!auth.userId && !auth.apiKeyId && !auth.isAdmin) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const copilot = copilotPricingCatalog()
  return c.json({
    providers: [
      {
        provider: 'copilot',
        source: copilot.source,
        models: copilot.models,
      },
    ],
  })
})
