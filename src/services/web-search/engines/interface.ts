import type { SearchResult } from "../types"

export interface SearchOptions {
  allowedDomains?: string[]
  blockedDomains?: string[]
}

export interface SearchEngine {
  readonly name: string
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
}

export function filterByDomain(url: string, options?: SearchOptions): boolean {
  if (options?.allowedDomains && options.allowedDomains.length > 0) {
    return options.allowedDomains.some((domain) => url.includes(domain))
  }

  if (options?.blockedDomains && options.blockedDomains.length > 0) {
    return !options.blockedDomains.some((domain) => url.includes(domain))
  }

  return true
}

export class QuotaExceededError extends Error {
  constructor(
    public readonly engineName: string,
    message: string,
  ) {
    super(message)
    this.name = "QuotaExceededError"
  }
}
