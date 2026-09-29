# C07 production prepared-call / dispatch integration

Status: implemented and frozen for root review and full CI. No commit, push, deployment, live provider request or live configuration changes. Product files were edited only in clean `reference-adoption-verify` at base `a3f6f125e2a49163f2926a6d40de71f57627a37e`; the dirty main and implementation product files were untouched. Root owns overall C07 acceptance and protected integration.

## Delivered behavior and explicit interfaces

- `callCodexResponsesPrepared(opts: CallCodexResponsesOptions): Promise<CodexPreparedCallResult>` and `callCodexResponsesCompactPrepared(opts: CallCodexResponsesCompactOptions): Promise<CodexPreparedCallResult>` return native `response: Response` plus typed `responsesAdapter?` / `compactAdapter?`. Existing `callCodexResponses` / `callCodexResponsesCompact` exports retain native Response return signatures. Those low-level compatibility wrappers remain transport-only; the production provider uses the prepared entrypoints.
- `PreparedCodexHttpCall` retains original payload, encoded body, exact serialized body text, request identity and the accepted codec's `CodexResponsesLiteRequest` containing callable map, request echoes and generated-prefix provenance. Responses preparation runs once before dispatch/retry; alpha search retains its prior lazy serialization behavior.
- `CodexProvider.fetch` captures the prepared result in its request-local terminal closure, returning the native transport parts plus explicit adapters. No properties are attached to a native Response and no mutable provider-level map carries response identities.
- `ProviderResponse.compactAdapter?: (result: ResponsesCompactionResult) => ResponsesCompactionResult` is the explicit native compact restoration seam. Generation keeps the already accepted frame/result seam. Gateway Responses JSON handling applies compact restoration before source observation and shared lifecycle synthesis. The existing generation SSE/JSON adapters already run before source observers/translation. The existing performance wrapper spreads typed metadata, so no wrapper change was necessary.
- Lite selection is solely `codexModelUsesResponsesLite(opts.model)`. The outbound internal marker is `x-openai-internal-codex-responses-lite: true`. No client header is copied into the freshly built upstream headers. The client metadata mirror is removed while other generation client metadata remains. Absent/false catalog values remain Standard; malformed metadata rejects before dispatch.
- Compact now receives the full post-boundary payload, encodes tools/instructions first, and only then selects the established compact wire fields. Its inverse uses original callable identity and generated-prefix provenance. Caller-owned duplicate prefixes and modified lookalikes remain. Native generation JSON Content-Type is retained; absent/non-JSON successful generation Content-Type still receives the existing SSE fallback.
- Credential lease/revision fence, account identity, device-derived installation identity, quota persistence, execution fetcher and signal paths are reused. Retry retains byte-identical encoded JSON, thread/session/turn metadata and captured account header. Access-only credentials never trigger OAuth refresh/retry. No storage policy, ownership or migration change.

## Focused production integration evidence

New `vnext/packages/gateway/tests/codex-responses-lite.sqlite.test.ts` uses migrated real temporary SQLite, real credential repository and real CodexProvider, plus fake network fetch transport. It does not mock modules or database operations. Generation/compact gateway tests execute production attempt, responder, snapshot writer, SQL snapshot store and immediate previous-response expansion. Coverage:

- absent / false / true / malformed catalog selections, injected header and metadata mirror stripping, retained unknown fields, caller immutability;
- generation JSON/SSE, complete compact encoding before field selection, restored result fields/callable identities;
- both endpoint retry bodies/identities/headers/signals, changed bearer only, bounded second-401 handling, access-only auth failures;
- canonical persisted input/output, owner isolation and immediate next-turn Standard dispatch with restored history;
- simultaneous same item IDs with opposite function/custom declarations;
- compact provenance restoration keeping exact caller duplicates and modified lookalikes;
- error, incomplete EOF and cancellation without successful SQLite snapshots.

The cancellation unit case asserts persistence behavior, not an actual network disconnect. Root independently reported an actual loopback HTTP abort propagation probe. No claims about a reader-only cancel mechanism or live remote provider compatibility are made here.

## Commands and observed results

1. `bun test vnext/packages/provider-codex/src/__tests__/provider.integration.test.ts vnext/packages/provider-codex/src/__tests__/fetch.test.ts`: initial run had 37 pass / 1 fail because a legacy test asserts the exact runtime TypeError string for unsupported bare-string input. A local variable rename changed that string. The original `opts.body.input.some` expression was restored, retaining existing behavior. The later combined run passed 54 / 54 before the final five new tests were added.
2. Initial new SQLite suite: 13 pass / 3 fail. Two synthetic OAuth fixtures omitted mandatory `id_token`; the absent-catalog test passed explicit undefined to a defaulted fixture argument and accidentally selected true. Corrected fixtures; these were not product defects or claims of behavior-level TDD red. Original output is saved in `task-C07-integration-initial-fixture-failures.log`.
3. `bun test vnext/packages/gateway/tests/codex-responses-lite.sqlite.test.ts`: **21 pass, 0 fail, 111 assertions**. Full output: `task-C07-integration-sqlite.log`.
4. From `vnext`: `bun test packages/provider-codex/src/__tests__ packages/gateway/tests/codex-responses-lite.sqlite.test.ts packages/gateway/tests/codex-credential-effects.sqlite.test.ts packages/gateway/tests/data-plane/chat-flow/responses packages/gateway/tests/data-plane/chat-flow/shared/provider-call-context.test.ts`: **531 pass, 0 fail, 3325 assertions, 36 files**. Full output: `task-C07-integration-regressions.log`.
5. `bun run --filter '@vibe-llm/gateway' typecheck`, `bun run --filter '@vibe-llm/provider-codex' typecheck`, `bun run --filter '@vibe-llm/provider-llm' typecheck`: each **exit 0** after final changes.
6. From `vnext`: `bunx eslint packages/provider-codex/src/fetch.ts packages/provider-codex/src/provider.ts packages/provider-llm/src/types.ts packages/gateway/src/data-plane/chat-flow/responses/attempt.ts packages/gateway/tests/codex-responses-lite.sqlite.test.ts`: **0 errors, 2 pre-existing preserve-caught-error warnings** at unchanged provider.ts lines 120/124; existing multiple-project resolver advisory. Full output: `task-C07-integration-lint.log`.
7. From `vnext`: `bun run scripts/check-framework-purity.ts`: **[framework-purity] OK**.
8. `git diff --check`: **exit 0**.

Root owns full `ci:local` and independent frozen runtime/review. Root reported 12 mutable actual loopback/SQLite cases passing; those are root-owned evidence and are not substituted for frozen acceptance here.

## Self-review and boundaries

- Read all five changed files/diffs. The accepted codec/catalog implementation was reused without modification. No new any, suppression or non-null assertion was introduced.
- Public native Response wrappers preserve their transport return contract. Correct Lite response restoration is exposed through the new prepared entrypoints and wired through the production provider; low-level callers opting to use the old wrappers receive raw native transport, as before.
- Compact uses a specifically typed adapter rather than passing compaction envelopes into the generation result inverse. Existing gateway lifecycle synthesis remains shared; no parser/error/terminal-state redesign.
- No successful snapshot is added for error, partial EOF or cancellation. Existing opt-in policy, writer behavior and owner filtering remain unchanged.
- `fetch.ts` is an existing large module. Replaced duplicate Responses retry implementations with one prepared Responses path, while preserving alpha-search behavior. Did not undertake unrelated refactors.
- Exact persisted canonical-history tests and root mutable loopback evidence support activation. Final acceptance remains subject to root frozen review/full CI. No live provider/account test was performed.

## Freeze

Five owned repository-relative paths are listed in the plain array `task-C07-integration-owned.json`. Their SHA256 hashes are in the plain map `task-C07-integration-frozen-sha256.json`. Product files are frozen; no further edits without root follow-up and regenerated hashes. No commits created.
