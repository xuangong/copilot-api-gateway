# Provider call context implementation report

Status: frozen clean candidate for independent review. Base: `60dfcbfcd9766f83698adb20808eeb4330ed8aef`.
Product workspace: `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify`.
Only this clean workspace was edited. No commit, push, deploy, live configuration, main/implementation product edits, or subagents.

## Interface and behavior

- `@vibe-llm/provider-llm` exports `ProviderExecutionIdentity`, `ProviderResponsesAdapter`, and its backward-compatible `ProviderResponse extends` core transport response. Execution fields are readonly `modelKey`, optional `serviceTier`, opaque non-secret `credentialSubject`/`credentialRevision`. Adapters are optional typed `frame` and `result` callbacks. Documentation requires immutable per-call preparation, prepared once before auth retries; no catalog or provider-instance callback state.
- Gateway takes a frozen flat execution snapshot immediately after each fetch. The shared parsed-response helper captures the frame callback before lazy iteration. Native Responses JSON adapts once before observation/event synthesis; SSE adapts parsed frames before observation/telemetry and outer provider/gateway interceptors. Translated requests reuse this same Responses hub boundary.
- `TelemetryModelIdentity.executedModelKey` distinguishes exact executed pricing from the upstream's reported model. All three native attempts select exact pricing from execution metadata; all four respond paths initialize `SourceStreamState` with that authoritative identity. `rememberModelKey`, final identity, and identity resolver preserve the exact key and cost. Without metadata, existing revision/alias inference remains unchanged. Existing public model normalization remains unchanged.
- An explicit workspace dependency on `@vibe-core/result` was added to provider-llm for the typed frame contract; lockfile change is exactly that dependency. No core package changes.

## Wrapper audit

- `fetchWithPerformance` already spreads the response when replacing its body and preserves both extras. A focused test exercises its real wrapping path with `PerformanceRecorder`.
- `traverseTranslation` spreads model identity and wraps its resolver, preserving executed identity for translated callers; tested with real Messages-to-Responses hub dispatch for JSON and SSE.
- Provider Codex/Copilot/Claude/custom dispatch wrappers operate on native Fetch `Response` before the final LLM ProviderResponse construction, so they do not currently receive LLM extras to lose. No provider produces new metadata in this foundation package. Future C01/C05/C07 producers must attach their final call-local context at that LLM boundary after auth retry; they must not attach it to intermediate native Responses and expect reconstruction to copy it.
- Non-2xx responses intentionally retain the existing error conversion and never run successful-response adapters. JSON parse/adapter errors retain internal-error handling; stream adapter throws retain iterator cleanup. Raw transport/dump capture is unchanged.

## Verification

All commands below run from `reference-adoption-verify/vnext`, except `git diff --check` which works from either repo root or vnext.

1. TDD initial focused test run: 4 expected failures, showing missing helper/JSON/SSE restoration and overwritten executed pricing state. Production was changed only after those failures.
2. `bun test packages/gateway/tests/data-plane/chat-flow/shared/provider-call-context.test.ts`: **14 passed, 0 failed, 44 assertions**. Tests cover concurrent response closure isolation, frozen execution snapshot, native JSON/SSE, translated Messages hub JSON/SSE, exact executed key and fallback, performance wrapper extras, callback failure/iterator cleanup, done frame passthrough/cancellation, unary exactly-once adapter, malformed JSON and non-2xx skips.
3. `bun test packages/gateway/tests/data-plane/chat-flow packages/provider-codex/src/__tests__/fetch.test.ts packages/provider-codex/src/__tests__/provider.integration.test.ts`: **568 passed, 0 failed, 1,560 assertions, 70 files**. Final log: `task-provider-call-context-focused.log` in this scratch directory. Includes existing Codex auth retry/fetch regression tests; these do not assert future Lite retry identity.
4. `bunx tsc --noEmit -p packages/gateway/tsconfig.json`: PASS.
5. `bunx tsc --noEmit -p packages/provider-llm/tsconfig.json`: PASS.
6. `bunx tsc --noEmit -p packages/protocols-llm/tsconfig.json`: PASS.
7. `bunx tsc --noEmit -p ../../reference-adoption/.superpowers/sdd/2026-09-29-reference-adoption-follow-up/task-provider-call-context-tests.tsconfig.json`: PASS. This scratch config strictly checks the new test fixture, including real ModelPricing fields `{input, output}`, branded test ApiKeyId, required ResponsesResult fields and binding shape.
8. `bun run scripts/check-framework-purity.ts`: PASS.
9. `bunx eslint packages/gateway/src/data-plane/chat-flow/{shared/attempt-helpers,shared/respond-telemetry,responses/attempt,responses/respond,messages/attempt,messages/respond,chat-completions/attempt,chat-completions/respond,gemini/respond}.ts packages/provider-llm/src/types.ts packages/protocols-llm/src/common/result.ts packages/gateway/tests/data-plane/chat-flow/shared/provider-call-context.test.ts`: PASS (existing informational multi-project resolver warning).
10. `git diff --check`: PASS. `bun install --ignore-scripts` completed successfully to link the new workspace type dependency.

During development the first provider typecheck exposed the missing explicit core/result dependency, which was added. An initial cancellation test incorrectly expected the outer telemetry decorator to preserve a transport done frame; it now tests the adapter boundary directly. The first scratch test typecheck omitted ambient types and exposed fixture typing gaps; its final config and fixtures pass. No unresolved failures.

## Self-review and boundaries

- Verified diff remains narrowly scoped to response typing/adaptation and exact execution pricing, with unchanged fallback behavior, translation metadata, shims, transport privacy, and continuation ownership/retention rules.
- This is C01/C05/C07 groundwork only: no actual Fast selection, Lite codec/catalog flag, credential renewal changes, cryptographic continuation carriers, new persisted columns, migrations, or production availability claims.
- Opaque identity/tier remain available on the LLM ProviderResponse contract; only executed model key is carried into telemetry. No credential metadata is persisted/logged here.
- This writer did not run full CI or actual app/runtime/SQLite acceptance. Root owns those independent gates and protected three-way integration. Parent-reported mutable runtime results are not counted as writer evidence; rerun against frozen hashes before acceptance.

## Owned files

Exact plain array: `task-provider-call-context-owned.json`.
Exact frozen SHA-256 plain map: `task-provider-call-context-frozen-sha256.json`.
14 product paths total:

- `vnext/bun.lock`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/gemini/respond.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/respond.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/respond.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/shared/provider-call-context.test.ts`
- `vnext/packages/protocols-llm/src/common/result.ts`
- `vnext/packages/provider-llm/package.json`
- `vnext/packages/provider-llm/src/types.ts`
