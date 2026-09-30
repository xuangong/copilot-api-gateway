# Task 4: Event producer domains and Responses settlement contracts

Status: implementation complete, focused verification passed, frozen for independent review. No commit, installation, deployment, full CI, Docker replacement, or service restart was performed. Task 1 files were not touched during Task 4.

## Implemented boundaries

- `LlmEventResult<T>` is a native/translated union. Native streams retain `AsyncIterable<T>` and explicitly forbid both adapters. The native constructor keeps its positional resolver compatibility; adapter slots accept only `undefined`. Translated streams carry opaque `ProtocolFrame<unknown>`, an explicit source and actual producer protocol, and separate required JSON/event adapters.
- `traverseTranslation` no longer casts hub events to source events. All four source consumers select parsing from the validated producer domain, independently of missing/stale translator telemetry. Invalid/missing metadata fails explicitly. Gemini is not supported as an upstream translated producer; native bare Gemini fixtures still use the endpoint-declared domain. The byte-level `ProviderResponse` contract is unchanged.
- Chat/Messages cross paths return before their native interceptor chains, so their interceptors now verify the native boundary without casts. Responses cross dispatch occurs inside its chain. Stream-only Responses transforms wrap the event adapter without consuming the body adapter. Active server-tool and compaction shims choose the JSON or SSE source adapter according to the invocation, then remove obsolete producer/adapters when replacing the stream. JSON normalization uses the complete body adapter and existing generic item lifecycle synthesis; it preserves body-only `metadata` and `instructions` fields. Copilot's opaque Responses ID membrane leaves translated results alone.
- `ResponsesTurn.facts` resolves after required continuation settlement, raw/source cleanup, and bounded metadata observation when existing sinks require it. Its outcome, shared response reference, cleanup flag, continuation operation status, and explicit metadata observation status do not depend on optional projection storage.
- `ResponsesTurn.receipts` records actual invocation fulfillment/rejection/skipping for usage, performance, dump metadata, and dump finalization. A fulfilled helper can be a no-op or can internally catch storage errors; this is not a durability claim. Usage still precedes performance and a rejection still skips later normal-path operations. Dump finalization remains in `finally`.
- `completion` still owns the full aggregate barrier. HTTP delivery remains early and WebSocket reuse still waits on completion. No-sink turns skip unresolved final metadata and create no new observer; this path completes within the focused 100 ms guard. Facts and projection input never await completion or `KitCanonicalCompletion.settled`.

## Red/green evidence

1. The real traversal/four-responder matrix started at 8 pass / 8 fail: each protocol's JSON consumer chose an incorrect collector when translator telemetry was absent/stale. Final producer tests contain 40 passing cases, including JSON/SSE rejection of missing, unknown, and wrong-source producer metadata.
2. Real SQLite delayed usage/performance and failure cases started at 0 pass / 6 fail because facts were unavailable. They now verify facts resolve while receipts/completion stay pending, HTTP is delivered early, and real repository writes eventually persist. An additional real SQLite usage table failure proves performance is skipped and dump finalization still runs.
3. Initial source normalization through only the event adapter failed both JSON compact/server-tool tests because body-only fields disappeared. Choosing the independent body adapter for JSON fixed both. Six shim cases pass: compact JSON/SSE, actual translated two-turn server-tool JSON/SSE, and collaboration response adapter JSON/SSE.
4. Additional facts coverage includes cancellation while a required snapshot remains pending, final metadata timeout/rejection, snapshot rejection, synchronous dump metadata failure, rejected/delayed dump finalization, and unresolved no-sink metadata.

## Final focused verification

- Interceptors, Responses WebSocket sessions/limits, translation traversal/custom translation, protocols common result: **383 pass / 0 fail / 1040 assertions**, 36 files. Includes `durable save and prior telemetry cleanup gate immediate next-turn inference`. Raw output: `task-4-focused.log`.
- Four protocol consumers, Responses source/turn barriers/JSON renderer, producer matrix, failure-wire/refusal compatibility, real SQLite sink lifetimes, Copilot membrane: **167 pass / 0 fail / 530 assertions**, 12 files. Raw output: `task-4-consumers.log`.
- Final provider membrane plus producer-shim tests after native test-collector narrowing: **15 pass / 0 fail / 50 assertions**, 2 files. Copilot's new translated pass-through case is included here.
- Gateway and protocols scoped typechecks passed. Provider scoped typecheck initially found its test collector treating union events as native; the collector now verifies native and the final provider scoped typecheck passed. The initial provider failure remains visible in `task-4-typecheck.log`; the follow-up `bun run --filter '@vibe-llm/provider-copilot' typecheck` returned exit 0.
- ESLint on all 36 owned source/test files: exit 0, no errors. Two pre-existing warnings remain: server-tool unused assignment, Gemini throw-only async generator. The newly added generator warning was removed. Raw output: `task-4-lint.log`.
- No broader performance/memory improvement claim is made; no full CI or deployment was run.

## Protected overlay and integration

Only the explicitly authorized pre-existing untracked collaboration shim changed. Original SHA-256: `806eed48ed36674d6c8e26250b8355f1f421b388eca0fdf3d762e9f811d239ff`.

- Original content: `task-4-preserved-collaboration-shim.ts.txt`.
- Adaptation-only patch: `task-4-collaboration-adaptation.patch` (adds one helper import, maps Responses source frames at the lazy adapter boundary, and independently restores the translated JSON body).
- Do not commit the whole pre-existing collaboration overlay as Task 4. Root must integrate only the compatibility adaptation using the preserved base/overlay workflow.
- Live baseline comparison: the other **12 of 13 protected files remain byte-identical**. Results: `task-4-protected-verification.json`.
- Full owned file list: `task-4-files.json`; frozen owned SHA-256 values: `task-4-final-hashes.json`.

## Verification limits

The actual cross-protocol request translator currently rejects namespace tools with a 400 `tools` validation error. Therefore the collaboration response adapter tests explicitly use translated fixtures and do not claim end-to-end namespace support through Chat. Existing native collaboration overlay tests pass in the interceptor suite. Actual compact and server-tool regressions do use `traverseTranslation`, the registered Chat translator, and source responders.

Nested translated event producers fail explicitly instead of concealing another hub-to-source conversion. Production hub attempts select their own same-protocol translator; upstream error results retain their existing deepest-target behavior.

## Owned source and test paths

- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-reasoning-content-dialect.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-tool-argument-whitespace-aborted.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-vendor-deepseek-normalized.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-vendor-kimi-normalized.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/gemini/respond.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-messages-web-search-shim.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-thinking-display-promoted.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/respond.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-responses-compact-shim.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-tool-argument-whitespace-aborted.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/source-result.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/turn.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/respond.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/gemini/respond.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/messages/respond.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/refusal-failed-json.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/respond.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/source-result.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/telemetry-lifetime.sqlite.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/turn-barrier.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/shared/stream-failure-wire.test.ts`
- `vnext/packages/protocols-llm/src/common/index.ts`
- `vnext/packages/protocols-llm/src/common/result.ts`
- `vnext/packages/protocols-llm/tests/common/result.test.ts`
- `vnext/packages/provider-copilot/src/interceptors/responses/with-item-id-membrane.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/collect-producer-result.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptor-source.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-responses-collaboration-shim.ts` (pre-existing untracked overlay; adaptation only)
- `vnext/packages/gateway/tests/data-plane/chat-flow/shared/producer-domain.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/shared/translated-fixture.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/producer-domain.test.ts`
- `vnext/packages/provider-copilot/src/__tests__/with-item-id-membrane.test.ts`


## Review round 1: producer rejection ownership (frozen 2026-10-01)

The independent review reproduced rejected producer domains losing their event ownership before rendering. The correction covers all newly introduced guards, including native interceptors and Responses source adaptation, instead of only the original three responder locations.

- `shared/producer-ownership.ts` owns rejection cleanup. It never reads unsupported frames. It invokes the available upstream abort callback, releases the concrete body owner, and requests iterator return with the existing one-second cleanup bound. Synchronous throws, rejected cleanup and hanging cleanup preserve the original producer error.
- Event-result metadata now carries an optional `discardProducer` callback. Chat, Messages and Responses native terminals bind that callback to the concrete body for that individual result, not a mutable multi-turn `upstreamResp` variable. This is necessary because returning an unstarted async generator does not execute its `finally` block. Traversal preserves the callback, including through translated results, and disposes nested translated results before returning the existing 502.
- Native guards are now async ownership-taking helpers; initial and continuation search turns pass their upstream cancellation owner. Responses materialize/map helpers perform the same validation cleanup before returning transformed results.
- The three non-Responses responders retain explicit producer errors and stamp failure rather than invoking canonical client cancellation. Where the concrete body owner exists, they release it without aborting the client signal; legacy/custom results without that owner retain the supplied controller as cancellation fallback.
- Responses turn finalization invokes the concrete disposer only when its upstream controller has aborted. Normal successful completion does not gain an additional disposal operation. Its failed facts and completion remain failed, and rejected/timed-out disposal contributes to the existing raw cleanup success gate.

Verification:

- Initial cleanup regression: **0 pass / 13 fail**, confirming all tested new rejection paths leaked return ownership before the correction (`task-4-cleanup-red.log`).
- Responses unopened-body turn regression independently reproduced **0 pass / 1 fail** before its finalizer change (`task-4-cleanup-turn-red.log`).
- Cleanup tests: **19 pass / 0 fail / 60 assertions**. Includes a real Chat attempt with an unopened `ReadableStream` (zero reads, one body cancellation, client signal un-aborted), nested translation owner propagation, actual Responses failed facts, and throwing/rejected/hanging disposal.
- Expanded consumer, attempt, interceptor and SQLite suites before the final Responses disposer addition: **514 pass / 0 fail / 1458 assertions**, 49 files (`task-4-cleanup-focused.log`).
- Final affected Responses/SQLite/WebSocket/producer suites after that addition: **174 pass / 0 fail / 528 assertions**, 8 files (`task-4-cleanup-turn-final.log`).
- All **42 owned files** scoped ESLint: exit 0, no errors, the same two prior warnings (`task-4-cleanup-lint.log`). `git diff --check` passed.
- Protocols and provider-copilot scoped typechecks passed. Gateway scoped typecheck passed after the native-body owner work; the task-time aggregate rerun was blocked by concurrent Task 6 `src/shared/dump/capture-budget.ts(18,59)` (`Estimate.reason`, TS2339), outside this task's ownership. Root has been notified; final integration typecheck remains required (`task-4-cleanup-typecheck.log`).

Protected overlay adaptations now have two explicitly authorized exceptions:

1. Collaboration shim: the prior source adapter adaptation, now awaited with its upstream callback; `task-4-collaboration-adaptation.patch` remains adaptation-only.
2. Responses attempt: new helper import, one traversal abort callback, and concrete per-result body disposer handoff; `task-4-responses-attempt-adaptation.patch` is the complete delta from root's preserved `original-responses-attempt.ts.txt`. Do not stage the entire original tracked overlay.

The other **11 of 13 protected files are byte-identical** to baseline. `task-4-files.json` and `task-4-final-hashes.json` now list/freeze all 42 owned files, including the four attempt modules and cleanup helper/test. No Git write, deployment, dependency installation or Task 6 source edit was performed.


## Commit isolation follow-up (2026-10-01)

The committed producer-shim regression imported the pre-existing untracked collaboration shim. Split this dependency without conditional imports or skipped tests:

- The tracked `responses/interceptors/producer-domain.test.ts` now contains only compact and server-tool cases (JSON/SSE), with no collaboration import or fixture dependency. This is the only file intended for the follow-up commit.
- New **untracked overlay-only** `responses/interceptors/producer-domain-collaboration.test.ts` contains both collaboration cases with its own setup, invocation fixture, and response reader. Its source import remains static and required. Preserve/copy this test only alongside the original collaboration shim and its compatibility adaptation; do not include it in the scoped Task 4 commit.

Validation:

- Both files in the preserved-overlay workspace: **6 pass / 0 fail / 31 assertions** (`task-4-isolation-focused.log`).
- Real clean-source validation: exported tracked `HEAD` using `git archive`, copied in only the modified tracked test, and linked workspace package dependencies to that isolated archive. The collaboration shim was asserted absent. The tracked test passed **4 pass / 0 fail / 25 assertions** (`task-4-isolation-clean-checkout.log`). The disposable archive was removed afterward; no Git writes or dependency installation occurred.
- Two-file ESLint: exit 0, no findings (`task-4-isolation-lint.log`); tracked `git diff --check` passed.
- All **13 protected files remain byte-identical** to their state before this follow-up. Only the tracked test and new overlay test changed.

Delivery: `task-4-isolation.diff` contains both files for review; `task-4-isolation-tracked.patch` is the commit-only removal; `task-4-isolation-overlay.patch` is the untracked test addition. `task-4-isolation-files.json` labels their different delivery ownership, and `task-4-isolation-hashes.json` freezes these two files. The earlier Task 4 frozen hash for the tracked test is superseded by this follow-up hash.
