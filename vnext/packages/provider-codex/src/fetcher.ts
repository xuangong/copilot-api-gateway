// Re-export from @vibe-core/upstream. Stage C unified the Fetcher alias so
// all providers share one type. Keep this re-export so existing imports of
// `./fetcher` from within provider-codex continue to work.
export { directFetcher, type Fetcher } from "@vibe-core/upstream"
