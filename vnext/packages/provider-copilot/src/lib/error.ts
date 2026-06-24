/**
 * HTTPError class — re-exported from @vnext-llm/provider-llm in Phase A Task 2 (X-2).
 *
 * Original definition lives at `@vnext-llm/provider-llm/src/errors.ts`. This file
 * stays so existing call-sites that import from
 * `@vnext-llm/provider-copilot/lib/error` keep working without churn; new code
 * should prefer importing from `@vnext-llm/provider-llm`.
 */
export { HTTPError } from '@vnext-llm/provider-llm'
