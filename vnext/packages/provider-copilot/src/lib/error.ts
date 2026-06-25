/**
 * HTTPError class — re-exported from @vibe-llm/provider-llm in Phase A Task 2 (X-2).
 *
 * Original definition lives at `@vibe-llm/provider-llm/src/errors.ts`. This file
 * stays so existing call-sites that import from
 * `@vibe-llm/provider-copilot/lib/error` keep working without churn; new code
 * should prefer importing from `@vibe-llm/provider-llm`.
 */
export { HTTPError } from '@vibe-llm/provider-llm'
