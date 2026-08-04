// Claude-code-local Fetcher type. Mirrors provider-codex's shape.
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export const directFetcher: Fetcher = (url, init) => fetch(url, init)
