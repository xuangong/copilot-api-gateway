// Shared Fetcher indirection.
//
// A `Fetcher` is any function with the same shape as WHATWG `fetch()`, taking
// a URL string and RequestInit and returning a Response. It is the injection
// point for Stage D's proxy fallback dispatcher: providers accept a Fetcher
// in their constructor, defaulting to `directFetcher` (runtime `fetch`), and
// the gateway layer swaps in a fallback-aware fetcher per upstream.
//
// Ported into @vibe-core/upstream so all providers can import the same alias
// instead of each declaring their own (provider-codex and provider-claude-code
// had duplicated copies before this stage).

// The signature deliberately mirrors `FetchLike` in @vibe-core/http so a
// Fetcher can be handed to fetchWithRetry without a cast; keep the two in sync.
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export const directFetcher: Fetcher = (url, init) => fetch(url, init)
