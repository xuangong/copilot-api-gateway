/**
 * Strip `service_tier` from Responses-style payloads.
 *
 * Copilot rejects requests carrying `service_tier`. Some clients (notably the
 * OpenAI Responses SDK) set it by default. Drop it before forwarding.
 *
 * Reference: copilot-gateway responses/strip-service-tier.ts
 */

export interface ServiceTierStripResult {
  stripped: boolean
}

export function stripServiceTier(
  payload: Record<string, unknown>,
): ServiceTierStripResult {
  if ("service_tier" in payload) {
    delete payload.service_tier
    return { stripped: true }
  }
  return { stripped: false }
}
