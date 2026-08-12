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

export const pricingRouter = new Hono<{ Bindings: Env }>()

pricingRouter.get('/pricing', (c) => {
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
