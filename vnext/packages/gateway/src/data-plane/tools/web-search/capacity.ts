export const DEFAULT_WEB_SEARCH_CAPACITY_POLICY = Object.freeze({
  operations: 64,
  responseBodyBytes: 1024 * 1024,
  ingressBytes: 8 * 1024 * 1024,
  privateEntries: 64,
  privateBytes: 4 * 1024 * 1024,
  pageEntries: 64,
  pageBytes: 2 * 1024 * 1024,
  chatContinuationBytes: 4 * 1024 * 1024,
})

export type WebSearchCapacityCategory = keyof typeof DEFAULT_WEB_SEARCH_CAPACITY_POLICY
export type WebSearchCapacityPolicy = Readonly<Record<WebSearchCapacityCategory, number>>

export class WebSearchCapacityError extends Error {
  constructor(readonly category: WebSearchCapacityCategory, readonly limit: number) {
    super(`Web search capacity exceeded: ${category} (${limit})`)
    this.name = "WebSearchCapacityError"
  }
}

export const validateWebSearchCapacityPolicy = (
  overrides: Partial<WebSearchCapacityPolicy> = {},
): WebSearchCapacityPolicy => {
  const policy: Record<WebSearchCapacityCategory, number> = { ...DEFAULT_WEB_SEARCH_CAPACITY_POLICY }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(policy, key)) throw new Error("Invalid web search capacity policy")
    const category = key as WebSearchCapacityCategory
    const value = overrides[category]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > policy[category]) {
      throw new Error("Invalid web search capacity policy")
    }
    policy[category] = value
  }
  return Object.freeze(policy)
}

// Array lengths count holes without inspecting or expanding array entries.
export const countWebSearchOperations = (args: Record<string, unknown> | null, limit: number): number => {
  let count = 0
  if (args !== null) {
    for (const key in args) {
      if (!Object.hasOwn(args, key)) continue
      const value = args[key]
      if ((key === "search_query" || key === "open" || key === "find") && value === undefined) continue
      const charge = Array.isArray(value) ? value.length : 1
      if (charge > limit - count) return limit + 1
      count += charge
    }
  }
  return Math.max(1, count)
}

/** Invocation-owned synchronous ingress admission, shared by all provider leaves. */
export interface WebSearchIngress {
  readonly responseBodyBytes: number
  assertOpen(): void
  debit(bytes: number): void
  fail(error: WebSearchCapacityError): void
}
