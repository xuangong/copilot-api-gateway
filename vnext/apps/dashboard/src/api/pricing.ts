import { api } from "./client"

export interface PricingTier {
  label: string
  /** Input-token count above which this tier applies. Absent on the default tier. */
  contextThreshold?: number
  pricing: {
    input?: number
    input_cache_read?: number
    input_cache_write?: number
    output?: number
  }
}

export interface PricingModel {
  displayName: string
  tiers: PricingTier[]
}

export interface PricingProvider {
  provider: string
  source: { url: string; verifiedOn: string }
  models: PricingModel[]
}

export interface PricingCatalog {
  providers: PricingProvider[]
}

export function getPricing(): Promise<PricingCatalog> {
  return api<PricingCatalog>("/api/pricing")
}
