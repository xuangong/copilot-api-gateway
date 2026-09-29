# D02 execution adapter and terminal provider fetcher foundation

Accepted prerequisite HEAD: `1a06f90020dac71142b10cf03100fa827016c2dc`. This package does not activate route/registry capture. The existing dirty collaboration files were left untouched.

## Implemented seam

- `gateway/src/shared/dump/upstream-dial-adapter.ts` exports `operationForProviderRequest(request)` and `createUpstreamDialObservationContext(collector)`. Construct one context for an opted-in logical request; `context.forOperation({ upstreamId, operation })` supplies a generic `DialObserver`. The context shares one `call_1`, `call_2`, … sequence across all upstreams and endpoints. Endpoint/action maps to a fixed operation label; unknown endpoints return `null`. URL text and generic dial's caller-provided upstream ID are never persisted.
- The adapter copies a bounded request prefix before dispatch. Text is counted in UTF-8 bytes with only bounded scratch storage, including lone surrogates and a cap ending inside a code point. Prepared bytes are counted without full-body diagnostic encoding; opaque bodies stay unobserved. Header pairs are consumed lazily from `Headers` or dial's normalized transport record. Collector header/metadata limits and storage sanitization remain in force; two fixed labels, `responses.compact` and `images.edit`, were added to the allowlist.
- Response observation is a lazy pull-through stream. No source read, lock, clone or tee occurs during wrapper creation. The returned Response preserves status, statusText, headers, URL, redirected, type, and metadata on explicit clone/clone-of-clone. Status 0 remains the original response. Capture/wrapping errors return the original usable response; source read errors and cancellation retain their original effect. Later cancellation still reaches the source after collector finalization, while the snapshot remains `not_consumed`.
- `ProviderPluginContext.executionFetcherForUpstream(upstreamId, request)` is optional, with `request` restricted to `endpoint`/`action`. Each of the six providers uses it only for terminal application HTTP calls. Their existing fetcher remains responsible for discovery, Copilot variant `/models`, GitHub/Codex/Claude OAuth/session operations, and SDF passport. Codex and Claude pass both fetchers into their backend options so an OAuth mint inside `fetch` stays ordinary. Provider retries continue using the execution transport for every actual application send, while prepared call identity and body reuse remain under existing provider logic.
- `resolveExecutionFetcher` isolates failures while constructing the optional diagnostic fetcher and falls back to the configured ordinary fetcher. Failures from an already returned fetcher are not swallowed.

The following route package should create the collector only under the existing retention gate, attach it to the dump, create one observation context for that dump, and pass an observed execution-fetcher factory only into selected provider bindings. It should call `operationForProviderRequest`, omit `null`, and use the fixed `forOperation` observer; no URL-shape inference is needed. Existing ordinary fetchers remain available for credential and catalog work. The request-token Copilot fallback needs a direct observed execution fetcher with a noncredential logical upstream ID. Zero recorded children does not prove no logical provider call or failure.

## Verification

- From `vnext`, `bun test packages/gateway/tests/upstream-dial-adapter.test.ts packages/gateway/tests/upstream-attempts.test.ts packages/provider-custom/src/__tests__/injected-fetcher.test.ts packages/provider-azure/src/__tests__/injected-fetcher.test.ts packages/provider-copilot/src/__tests__/injected-fetcher.test.ts packages/provider-sdf/__tests__/headers.test.ts packages/provider-codex/src/__tests__/provider.integration.test.ts packages/provider-claude-code/src/__tests__/provider.integration.test.ts`: **89 passed, 0 failed, 381 assertions**. Adapter cases cover fixed operations, shared parent IDs, exact Unicode/byte caps, prefix ownership, response metadata/clone, status 0, wrapping failure, pending cancellation, finish-before-cancel, source read error, lazy headers, and existing collector budgets. Six-provider cases cover ordinary discovery/auth/passport separation and 401 retry where applicable.
  - `packages/gateway/tests/{upstream-dial-adapter,upstream-attempts}.test.ts`
  - `packages/provider-{custom,azure,copilot}/src/__tests__/injected-fetcher.test.ts`
  - `packages/provider-sdf/__tests__/headers.test.ts`
  - `packages/provider-{codex,claude-code}/src/__tests__/provider.integration.test.ts`
- `bun run typecheck`: exit 0 across the vNext workspace packages.
- `bun run scripts/check-framework-purity.ts`: `[framework-purity] OK`.
- `bun run lint`: exit 0, 0 errors, 36 warnings.
- `git diff --check`: exit 0.

These are Bun test/fake-fetcher checks, not an activated gateway request. This task did not run local service integration, workerd wrapper probes, full clean CI, or deployment; root owns those checks and the following route activation. No migration, dashboard change, commit, push, or live data operation was made.
