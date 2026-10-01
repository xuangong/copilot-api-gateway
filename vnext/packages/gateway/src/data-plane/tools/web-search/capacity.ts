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

/** Borrowed JSON-like graphs must not be mutated after admission. Reflection of
 * already-created input is outside this bounded traversal and retention charge. */
export const estimateRetainedCharge = (
  value: unknown,
  category: WebSearchCapacityCategory,
  limit: number,
  key?: string,
): number => {
  let charge = 0
  let visited = 0
  const ancestors = new Set<object>()
  const fail = (): never => { throw new WebSearchCapacityError(category, limit) }
  const debit = (bytes: number): void => {
    if (bytes > limit - charge) fail()
    charge += bytes
  }
  const visit = (node: unknown, depth: number): void => {
    if (++visited > 65536 || depth > 64) fail()
    if (typeof node === "string") { debit(32 + 2 * node.length); return }
    if (node === null || typeof node === "number" || typeof node === "boolean" || typeof node === "undefined") { debit(8); return }
    if (typeof node !== "object") return fail()
    const prototype: unknown = Object.getPrototypeOf(node)
    const array = Array.isArray(node)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail()
    if (ancestors.has(node)) fail()
    debit(array ? 64 + 8 * node.length : 64)
    ancestors.add(node)
    for (const key of Reflect.ownKeys(node)) {
      if (typeof key !== "string") return fail()
      debit(16 + 32 + 2 * key.length)
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      if (descriptor === undefined || !("value" in descriptor)) return fail()
      visit(descriptor.value, depth + 1)
    }
    ancestors.delete(node)
  }
  if (key !== undefined) visit(key, 0)
  visit(value, 0)
  return charge
}

export interface RetainedMap<Value> {
  get(key: string): Value | undefined
  set(key: string, value: Value): void
  clear(): void
}

/** Clear retires the owned capability; no eviction or late write is allowed. */
export const createOwnedRetainedMap = <Value>(options: {
  entries: number
  bytes: number
  entriesCategory: WebSearchCapacityCategory
  bytesCategory: WebSearchCapacityCategory
  assertOpen?: () => void
  fail?: (error: WebSearchCapacityError) => void
}): RetainedMap<Value> => {
  const entries = new Map<string, { value: Value; charge: number }>()
  let bytes = 0
  let closed = false
  return {
    get: key => closed ? undefined : entries.get(key)?.value,
    set(key, value) {
      options.assertOpen?.()
      if (closed) throw new Error("Retained web search state is closed")
      try {
        if (!entries.has(key) && entries.size >= options.entries) throw new WebSearchCapacityError(options.entriesCategory, options.entries)
        // Estimate the entire candidate against the domain limit so error metadata
        // never exposes a remaining budget or payload-derived value.
        const charge = estimateRetainedCharge(value, options.bytesCategory, options.bytes, key)
        options.assertOpen?.()
        if (closed) throw new Error("Retained web search state is closed")
        const old = entries.get(key)
        if (old === undefined && entries.size >= options.entries) throw new WebSearchCapacityError(options.entriesCategory, options.entries)
        if (charge > options.bytes - bytes + (old?.charge ?? 0)) throw new WebSearchCapacityError(options.bytesCategory, options.bytes)
        entries.set(key, { value, charge })
        bytes = bytes - (old?.charge ?? 0) + charge
      } catch (error) {
        if (error instanceof WebSearchCapacityError) options.fail?.(error)
        throw error
      }
    },
    clear() { closed = true; entries.clear(); bytes = 0 },
  }
}

export const createGeneratedStateAdmission = (
  limit: number = DEFAULT_WEB_SEARCH_CAPACITY_POLICY.chatContinuationBytes,
): ((value: unknown) => void) => {
  let bytes = 0
  return value => {
    const charge = estimateRetainedCharge(value, "chatContinuationBytes", limit)
    if (charge > limit - bytes) throw new WebSearchCapacityError("chatContinuationBytes", limit)
    bytes += charge
  }
}
