// Codex-local Fetcher type. vNext has no shared Fetcher alias yet; we can
// promote this later if other providers need the same indirection.
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export const directFetcher: Fetcher = (url, init) => fetch(url, init)
