# C07 codec/catalog foundation delivery

Status: foundation implemented and frozen; overall C07 remains **partial**. Production Lite dispatch is not active. No commit, push, deploy, live provider request, shared runtime/config mutation, or main/implementation product edit was performed.

Base: `0c84022de7a61b5e1b6cd22f3cd36eda4c776eb6`. Product worktree: `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify`. Reference: local pinned `1d7dcd923e260e425120cca0c7a240e93720af27`, `packages/provider-codex/src/responses-lite.ts` and `packages/provider-codex/__tests__/responses-lite_test.ts`. The source pointers copied as comments are reference evidence, not newly fetched first-party acceptance.

## Delivered contracts

- Full reference pure encode/inverse behavior: declaration consolidation without deduplication; functions namespace; base instruction metadata; OID UUIDv5 thread-scoped IDs; unchanged callable history; narrowly scoped image detail removal; caller tool_choice preservation; effective parallel/reasoning wire settings; namespace/type collision rejection; search-loaded declarations inventoried without relocation; top-level tools/instructions inverse echoes; generated-prefix provenance retaining caller duplicates and modified lookalikes; unknown/opaque extensions retained.
- Reference exports retained: `encodeCodexResponsesLiteRequest`, `restoreCodexResponsesResult`, `restoreCodexResponsesCompactionResult`, `restoreCodexResponsesEvent`, `restoreCodexResponsesFrames`, `CodexResponsesBody` and `CodexResponsesLiteRequest`.
- New `createCodexResponsesLiteAdapter(prepared: CodexResponsesLiteRequest): Required<ProviderResponsesAdapter>` returns synchronous `frame` and `result` functions. Each factory/iterator allocates its own item-ID map. Both frame APIs use the same internal restorer. Done frames preserve identity; exceptions/cancellation/EOF remain caller/parser-owned; no terminal frame is invented. This is a factory only; no provider activates it yet.
- Strict `use_responses_lite` raw catalog boolean and `providerData.useResponsesLite`; absent/false selects Standard, non-boolean rejects. `codexModelUsesResponsesLite({ id, providerData?: unknown })` is exported. Existing model fields/capabilities remain intact.
- Catalog revision 5 -> 6 invalidates older discovery representations. Maintenance fixture now follows the current revision and still tests malformed/missing-current policies and preservation of unknown newer versions.

## Typed protocol changes

The accepted base lacked actual reference codec shape declarations. With root approval, `protocols-llm/src/responses/events.ts` and `index.ts` now add typed callable/namespace declarations and `ResponsesTool`, `ResponsesAdditionalToolsItem` plus input/output union membership, search-output tools, function namespace, optional/original image detail, multimodal custom tool output, queued resource/event, and tools/instructions/reasoning/parallel/tool_choice/service_tier response echo fields. No schema/parser runtime behavior changed. The open schema index signature erases named types under Omit, so `CodexResponsesBody` explicitly retains canonical input/tools/instructions types. No private untyped protocol mirror, `any`, suppressions, or new non-null assertions were added.

Exhaustive-consumer evidence: strict typecheck passed provider-codex, protocols-llm, translate and gateway after all edits. No downstream implementation changes were needed; full workspace CI remains root-owned. The two protocol files overlap protected user-delta paths in main; only clean verify baseline was read/edited. Root owns protected three-way integration and inverse byte proof.

## Dependency ownership and installation

`provider-codex` explicitly owns exact `uuid@14.0.1`, matching the reference UUIDv5 API, with no transitive dependencies. Established UUID namespace/UTF-8/version-bit behavior is used instead of hand-writing SHA1 or UUID rules. Bun generated the package and lock change. Initial install hit cross-device clonefile EXDEV; `bun install --backend=copy` completed successfully. No global install.

The generated lock entry uses this machine's configured public Microsoft npm mirror and its supplied sha1 integrity. A direct registry.npmjs.org metadata attempt failed with Socket not connected; the actual Bun-produced entry was retained rather than inventing metadata. Root's independent mutable Bun/workerd probe reports UUID success, but frozen runtime and reproducible clean install review remain root acceptance responsibilities.

## Verification

- Red: reference codec test imported missing module before implementation; catalog helper and adapter tests imported missing exports before implementation. These are missing-surface failures, not a claim of assertion-level red for every ported branch.
- Red/green concrete regression: catalog revision bump caused maintenance fixture to fail because its active policy hard-coded 5; fixture now derives current/previous/newer revisions and passes.
- Full 47 reference parameterized codec cases ported with all behavior assertions preserved. Test-only `present` guard replaces reference non-null assertions; structural expectations use `expect<unknown>` for unknown wire extensions and compact input carriers rather than manufacturing output types.
- New focused suite totals **75 pass, 0 fail, 1385 assertions** across codec/reference, adapter and strict catalog tests. Added independent Python uuid vectors for ASCII and Chinese/emoji threads/instructions; identical item-ID concurrent adapter isolation; result echoes; one-byte-chunk UTF-8 SSE; malformed JSON/null parser errors; accepted scalar-extension behavior; error propagation, upstream iterator cancellation and natural EOF.
- All provider-codex tests: `bun test vnext/packages/provider-codex/src/__tests__` -> **211 pass, 0 fail, 2308 assertions**, 14 files.
- Catalog regression: `bun test vnext/packages/gateway/tests/catalog-maintenance.test.ts vnext/packages/gateway/tests/providers-registry.test.ts` -> **40 pass, 0 fail, 95 assertions**.
- Final strict `typecheck`: provider-codex, protocols-llm, translate, gateway -> exit 0.
- `bun run scripts/check-framework-purity.ts` -> OK.
- Targeted ESLint on all changed/new source/test implementation files -> exit 0 (only existing multiple-project resolver advisory).
- `git diff --check` -> exit 0.

Malformed boundaries are preserved, not redesigned: existing parser rejects malformed JSON and null, but projects scalar JSON with an SSE event name into an opaque event; adapter tests cover both behaviors without modifying parser validation. Codec accepts canonical typed input; no decryption of opaque payloads occurs.

## Remaining integration seams

1. Build a per-call prepared object before auth retry containing original payload, encoded payload, session/thread/turn identity, prefix provenance, callable map and echoes. Reuse exact serialized bytes/identity on 401. Codec factory must be created once per call and retained across retry.
2. Fetch currently returns native Response while provider reconstructs ProviderResponse; introduce an explicit prepared-call return contract that carries responsesAdapter to the gateway. Do not attach extras that are lost during reconstruction.
3. Encode compact input before `toCompactPayloadShape` discards tools/instructions. Preserve generated-prefix provenance until parsed compact output is restored via the compaction function. Restore before dumps/usage/continuation snapshots/source observers.
4. Select solely from authoritative catalog metadata; strip unauthorized incoming header/client-metadata Lite markers. Add the outbound internal marker only when selected. Keep existing Responses/compact endpoints, native JSON and SSE, auth/signal/quota/owner/account/device/header semantics.
5. Root acceptance still needs full CI, independent frozen review/runtime, actual gateway fake-upstream integration including exact 401 retry bytes, Standard malicious marker stripping, compact/source history persistence and immediate continuation, error/EOF/cancellation without successful terminal snapshots. Existing provider tests do not claim Lite dispatch acceptance. Live provider/account testing was not run.

## Freeze

12 owned repository-relative paths are in `task-C07-codec-owned.json` (plain array). Their SHA256 values are in `task-C07-codec-frozen-sha256.json` (plain map). Product files were frozen before this report; no further writer edits are authorized without a root follow-up and regenerated freeze.
