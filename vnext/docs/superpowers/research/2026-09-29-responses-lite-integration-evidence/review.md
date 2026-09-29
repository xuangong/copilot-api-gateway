## Spec compliance

**Spec compliant for the scoped C07 production integration.** No missing or extra behavior requiring correction was found in the five-path frozen diff against base `a3f6f125e2a49163f2926a6d40de71f57627a37e`. The accepted codec/catalog foundation was treated as an unchanged dependency. C08 and prior deferred findings were not reopened.

- **Typed call-local seam:** `vnext/packages/provider-codex/src/fetch.ts:135-169` returns native `Response` plus explicit generation/compact adapters. `vnext/packages/provider-codex/src/provider.ts:174-199` captures those adapters inside the individual fetch invocation and forwards them in `ProviderResponse`; it does not decorate native Response objects or share a provider-global identity map. `vnext/packages/provider-llm/src/types.ts:49-54` gives compact a separate typed result seam.
- **Prepare once and retain identity/bytes:** `vnext/packages/provider-codex/src/fetch.ts:159-167,612-663` computes original/encoded payload, identity, callable map/provenance and serialized JSON before dispatch. The 401 path passes the same prepared object back into the bounded retry. The exact-byte/header/signal assertions cover generation and compact at `vnext/packages/gateway/tests/codex-responses-lite.sqlite.test.ts:98-126`; second-401 and access-only cases retain their bounded/no-refresh behavior.
- **Catalog-only selection and Standard sanitization:** `vnext/packages/provider-codex/src/fetch.ts:344-351,538,628-634` strips the metadata mirror, selects using the strict catalog helper, and emits the internal header only when the prepared call carries Lite. Standard/absent/true selection and retained ordinary metadata/unknown extensions are asserted at `vnext/packages/gateway/tests/codex-responses-lite.sqlite.test.ts:79-96`; malformed metadata and Standard compact sanitization are covered at lines 213-228.
- **Restoration before observation/persistence:** `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts:348-362` applies the compact or generation JSON adapter before source observation and lifecycle synthesis, and the existing frame adapter precedes frame observation on SSE. `vnext/packages/gateway/tests/codex-responses-lite.sqlite.test.ts:139-175` checks real SQLite canonical output, key isolation, and immediate continuation; lines 177-185 cover concurrent identical item IDs with opposite callable declarations.
- **Compact provenance:** `vnext/packages/provider-codex/src/fetch.ts:625-634` runs the codec before selecting compact fields; lines 164-166 pass the call's exact callable identities and generated-prefix provenance into the compact inverse. `vnext/packages/gateway/tests/codex-responses-lite.sqlite.test.ts:231-247` keeps caller duplicates and modified lookalikes and checks caller immutability.
- **Failure semantics and scope:** `vnext/packages/gateway/tests/codex-responses-lite.sqlite.test.ts:188-201` verifies error/EOF/cancel do not create a successful snapshot. No persistence-policy, ownership, schema, credential-effect, or unrelated protected-file implementation was changed by this scoped patch.

## Strengths

- The production API explicitly distinguishes native transport, generation restoration, and compact restoration instead of depending on hidden Response properties (`fetch.ts:135-169`, `provider-llm/src/types.ts:49-54`). This keeps the integration readable and compatible with the existing transport wrappers.
- The common prepared Responses path removes duplicate generation/compact retry logic while retaining one request identity and one serialized body (`fetch.ts:612-663`). Alpha-search remains on its existing path.
- The new 247-line test file exercises real repository and snapshot-store operations, the production CodexProvider, attempt/responder, and previous-response expansion. The tests assert actual outbound bytes and canonical persisted items, rather than only adapter presence (`codex-responses-lite.sqlite.test.ts:28-75,98-175`).

## Issues

- **Critical:** None found.
- **Important:** None found.
- **Minor introduced by this task:** None found. The reported two existing safe-error lint warnings are inherited, already deferred outside this task, and were not reopened.

## Focused checks outside diff context

- **Named risk: performance wrapping could drop call-local adapters or observe raw Lite output.** Inspected `vnext/packages/gateway/src/data-plane/chat-flow/shared/performance-upstream.ts:8-43`: it spreads the full typed response while replacing only `body`; its source observers are invoked by the restored JSON/frame path. Also inspected the rest of the cut-off Responses attempt function and its JSON/frame helper at `responses/attempt.ts:182-216,308-362`, confirming non-2xx handling remains ahead of adapters and restoration is ahead of observation.
- **Named risk: other source protocols might bypass the restored Responses hub.** Focused call-site lookup in the Chat Completions, Messages, and Gemini attempt modules confirms they use `traverseTranslation`; `responses/attempt.ts:231-240` identifies that hub re-entry, and `shared/attempt-helpers.ts:87-131` captures and applies the per-call frame adapter before telemetry. No cross-protocol implementation edits were needed in this diff.
- **Named risk: moving compact field selection could lose declarations before encoding or mutate caller input.** Inspected the existing compact field selector and body builder at `provider-codex/src/fetch.ts:87-104,463-483`, plus the small unchanged Codex response boundary index/system-role interceptor. The new call passes the full post-boundary payload to encoding and projects compact fields afterward; the existing boundary replaces rewritten input items rather than mutating them. The integration tests independently check immutable caller payloads.
- No broad repository crawl, Git operations, product/index/branch edits, suite reruns, subagents, network provider calls, commits, pushes, or deployments were performed. The full 807-line scoped patch was read in three sequential chunks. Additional changed-file reads were limited to the functions whose patch hunks omitted the code needed for the named integration checks above.

## Verification and limits

- Read `task-C07-integration-sqlite.log`: **21 pass, 0 fail, 111 assertions**.
- Read the end of `task-C07-integration-regressions.log`: **531 pass, 0 fail, 3,325 assertions, 36 files**.
- Read `task-C07-integration-lint.log`: **0 errors, 2 inherited warnings** plus the existing multi-project resolver advisory. The report also records package typechecks, framework purity, and diff whitespace checks passing. These are recorded implementation runs, not reruns by this reviewer.
- Read `/tmp/vnext-c07-integration-frozen-runtime.out`: `passed: true` for the 12 frozen real loopback gateway/CodexProvider/temporary-SQLite cases, including both retry endpoints, Standard marker rejection, compact, concurrent identities, continuation, error, EOF, and cancellation; `liveProvider: false`.
- Root reports full frozen clean CI **4,718 pass / 1 skip / 0 fail**, all gates exit 0 with 35 inherited warnings. Read the final `/tmp/vnext-c07-integration-clean-ci.log` section confirming Workers dry-run exit 0. Root also reports byte-exact forward/reverse protected-overlap preflight in both dirty trees. This review did not independently repeat CI or the protected merge proof.
- **Cannot verify from the scoped diff alone:** the already accepted codec's entire inverse matrix, freshness/authorization of the unchanged C02 catalog supply, every unchanged retention/auth route, and the protected dirty-tree integration. Those remain inherited/root-owned evidence. No live remote-provider compatibility or account-renewal claim is made. No new focused execution was needed because the named source checks and existing integration evidence resolved the concrete risks examined here.

## Assessment

**Task quality: Approved.** The scoped change connects the accepted codec through explicit per-call contracts, preserves prepared retry identity, and places restoration at the required source-observation boundary. The real-SQLite tests and root's frozen loopback evidence cover the principal production integration requirements without changing retention or credential semantics.
