# D02 route activation independent review

## Spec Compliance

- **Approved for this task.** The frozen candidate implements the complete route activation matrix without a task-scoped correctness or scope blocker. Base: `a68a6732dddfdf78a1bad06c634ad9fd3cb8286b`; candidate: `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify`; reviewed all 27 paths in `task-D02-route-activation-review.patch`, including the text hunks for the inherited-NUL image server-tool file.
- **Code quality: Approved**, with the non-blocking output-noise finding below. No product edits, Git operations, tests, subagents, deployment, or live configuration/data operations were performed by this reviewer.
- **Cross-task limits remain explicit.** This is the final activation task review, not a second audit of the accepted collector/dial/provider/storage foundations or of the eventual protected-dirty integration. Those boundaries are listed below.

## Strengths

- One retained accumulator owns the collector and observation context; the registry only asks for it through the optional dump and isolates setup failure. The execution factory reuses the ordinary factory's loaded catalog/fallback map rather than introducing an alternate egress policy (`packages/gateway/src/shared/dump/accumulator.ts:134`, `packages/gateway/src/data-plane/providers/registry.ts:348`, `packages/gateway/src/data-plane/dial/per-request.ts:47`).
- Terminal operation selection remains explicit, and the no-stored-row Copilot path uses fixed `copilot_request` with an explicit direct-fetch chain (`packages/gateway/src/data-plane/providers/registry.ts:354`, `packages/gateway/src/data-plane/providers/registry.ts:399`, `packages/gateway/src/data-plane/dial/per-request.ts:81`).
- Request state stays out of the protocol and authentication scope contracts: the kit carries its existing opaque sink; the gateway owns `GatewayRequestContext`; image re-enumeration receives the same dump while retaining the original binding scope (`packages/chat-flow-kit/src/serve-template.ts:77`, `packages/gateway/src/data-plane/chat-flow/shared/gateway-ctx.ts:18`, `packages/gateway/src/data-plane/chat-flow/responses/attempt.ts:375`, `packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/image-generation.ts:1148`).
- The new tests exercise real app/auth/registry/provider/dial/repository/file-storage paths, not a mock database. They assert persisted sidecars and owner-scoped wire output, actual discarded-body cancellation, and request-local parent sequences (`packages/gateway/tests/dump-route-activation.test.ts:43`, `:164`, `:259`, `:345`, `:384`, `:399`).

## File-by-file scope check

All paths below are relative to `vnext/`; references identify the reviewed candidate hunks.

| Reviewed path | Evidence and result |
| --- | --- |
| `packages/chat-flow-kit/src/serve-template.ts:77,246` | Adds only an optional opaque sink to attempt arguments and forwards the existing input dump. |
| `packages/gateway/src/data-plane/alpha-search/routes.ts:101,141` | Uses the existing retention opener, shared body bytes, response/error finalization, and passes dump only into passthrough selection. |
| `packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts:101,123` | Selection and translated hub dispatch retain the dump. |
| `packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts:101` | Passes kit dump to attempt. |
| `packages/gateway/src/data-plane/chat-flow/count-tokens/serve.ts:35` | Retained dump reaches count-token binding resolution. |
| `packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts:144,200` | Selection and translated hub dispatch retain the dump. |
| `packages/gateway/src/data-plane/chat-flow/gemini/count-tokens.ts:44` | Same gate reaches the Messages count-token terminal. |
| `packages/gateway/src/data-plane/chat-flow/gemini/serve.ts:118` | Passes kit dump to attempt. |
| `packages/gateway/src/data-plane/chat-flow/messages/attempt.ts:140,321,341` | Selection and translation retain the dump and existing hosted-tool context. |
| `packages/gateway/src/data-plane/chat-flow/messages/serve.ts:106` | Passes kit dump to attempt. |
| `packages/gateway/src/data-plane/chat-flow/responses/attempt.ts:147,223,272,375` | Selection, translated dispatch and re-entrant interceptor context retain the dump. |
| `packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts:1101` | Forwards gateway-local dump into server-tool request context. |
| `packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/image-generation.ts:1026,1148,1696` | Carries dump through shim state and secondary binding enumeration; preserves existing owner/pin filtering. |
| `packages/gateway/src/data-plane/chat-flow/responses/serve.ts:194` | Passes dump for generate and compact through their common attempt hook. |
| `packages/gateway/src/data-plane/chat-flow/shared/gateway-ctx.ts:18` | Keeps diagnostic state gateway-local. |
| `packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts:82` | Chat selection forwards dump alongside unchanged auth scope. |
| `packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts:122` | Shared traversal forwards the same dump to the inner attempt. |
| `packages/gateway/src/data-plane/dial/per-request.ts:32,47,65,81` | Optional observer reuses configured transports/fallbacks; malformed/unknown upstream safeguards remain; request-token path is explicitly direct. |
| `packages/gateway/src/data-plane/embeddings/routes.ts:81` | Existing retained dump reaches embedding binding. |
| `packages/gateway/src/data-plane/images/routes.ts:97,229` | Both generation and separate edit/multipart binding paths receive dump. |
| `packages/gateway/src/data-plane/orchestrator/server-tools/types.ts:126` | Optional gateway dump added to server-tool context only. |
| `packages/gateway/src/data-plane/providers/registry.ts:348,350,355,369,399` | Optional request-local observation, explicit operation selection, ordinary provider/catalog fetchers retained, safe direct request-token fallback. |
| `packages/gateway/src/data-plane/routing/binding-resolver.ts:48` | Forwards dump without changing model/owner/pin resolution. |
| `packages/gateway/src/data-plane/routing/candidates.ts:83` | Forwards dump without changing candidate filtering. |
| `packages/gateway/src/data-plane/tools/web-search/alpha-search/upstream.ts:43` | Passes dump to the configured upstream selection; no engine-fetch wrapping introduced. |
| `packages/gateway/src/shared/dump/accumulator.ts:134` | Lazily reuses exactly one collector and observation context per accumulator. |
| `packages/gateway/tests/dump-route-activation.test.ts:115` | 36 cases cover the endpoint matrix plus the behavioral assertions below. |

## Acceptance evidence checked

- **Endpoint coverage:** twelve table-driven route cases, four translations, separate multipart images, and actual image server-tool re-entry (`packages/gateway/tests/dump-route-activation.test.ts:115,142,152,399`). The re-entry case asserts Responses/image/Responses parent IDs `call_1`, `call_2`, `call_3` on one dump.
- **Off and exclusions:** no observation-context allocation, dump row, spilled file, or provider body replacement with retention off; ordinary catalog/probe calls and retained discovery produce no application child; local search engine HTTP has no application sidecar (`packages/gateway/tests/dump-route-activation.test.ts:187,245,420,452`).
- **Retry/fallback behavior:** actual stored Copilot 401 and 403 refresh cases followed by 429/success assert three parents, two ordinary token exchanges and zero reads of the discarded 429 source; actual proxy machinery failure/direct fallback asserts two children under one parent and persisted proxy backoff (`packages/gateway/tests/dump-route-activation.test.ts:259,384`).
- **Stream semantics:** finite complete/malformed SSE both reach transport EOF while malformed protocol data independently marks logical error; binding no-read/cancel/read-error and caller abort retain the appropriate terminal state and unknown non-EOF total (`packages/gateway/tests/dump-route-activation.test.ts:299,319,426`).
- **Isolation/privacy/failure boundary:** two owners get independent `call_1` sequences and foreign detail access returns 403; adversarial synthetic URL/header values are absent from decompressed sidecar, detail and export; observer setup failure preserves success (`packages/gateway/tests/dump-route-activation.test.ts:164,345,374`).
- **Prefix caps:** 70 KiB request / 300 KiB response fixture asserts 64 KiB / 256 KiB retained prefixes, exact observed totals, truncation and intact client JSON (`packages/gateway/tests/dump-route-activation.test.ts:465`).
- **Focused result:** inspected `/tmp/d02-focused-tests.out`: 215 pass, 0 fail, 919 assertions, 15 files. Inspected `/tmp/d02-purity.out` and targeted lint output; no suite rerun.
- **Frozen clean CI:** inspected `/tmp/vnext-d02-route-activation-clean-ci.log:1` and final output: purity, workspace typechecks, 4364 pass / 1 skip / 0 fail (`:6511`), lint with 36 warnings (`:6619`), UI build, Wrangler dry-run exit 0. Root supplied the overall exit-0 result.
- **Frozen runtime:** inspected root's `task-D02-route-runtime.mjs`, its actual `task-D02-route-worker.ts` entrypoint, and `/tmp/vnext-d02-route-final-runtime.out:10`. The fixture uses real local workerd/D1/R2 and loopback HTTP; its two retained owners cover Responses SSE/JSON, retention-off, discovery exclusion, safe sidecar/detail/export and foreign-owner rejection. Output is `passed:true`. This is synthetic local integration, not a live vendor/deployment claim.

## Named-risk dependency checks

- **Risk: optional diagnostic factory construction might bypass configured proxy egress.** Checked the unchanged `packages/provider-llm/src/plugin.ts:17`: setup failure returns the supplied ordinary fetcher; transport invocation is outside this catch. Combined with the changed shared factory in `packages/gateway/src/data-plane/dial/per-request.ts:47`, no alternate proxy-bypassing recovery is introduced.
- **Risk: adding the alpha-search opener might fail inference on optional storage lookup or read the request twice.** Checked unchanged `packages/gateway/src/data-plane/chat-flow/shared/dump-open.ts:23` and `packages/gateway/src/shared/dump/request-body.ts:30`: the key/opening path catches diagnostic lookup failures; the body is read once and shared with parsing. Final response capture/storage internals remain a prior-task contract, additionally exercised by the route tests.
- **Risk: an unmodified orchestrator binding caller could be missed.** Focused `runOrchestrator` reference search under gateway source found only its definition at `packages/gateway/src/data-plane/orchestrator/loop.ts:32`, no production caller requiring a new dump argument. The actual Responses server-tool execution and secondary image binding are wired and tested in this patch.
- No changed source function was separately re-read in full after its diff. The 2,140-line patch was reviewed in four non-overlapping segments; focused symbol lookup located existing finalization boundaries, and a metadata-only pass calculated citation line numbers.

## Issues

### Critical

- None found in the task diff.

### Important

- None found in the task diff.

### Minor

- **Validation output is not pristine.** `/tmp/d02-focused-tests.out:7,130,217,269` includes expected failure/retry logging; the new Copilot retry cases also report approximately 62-second route latency because they deliberately advance `Date.now` (`packages/gateway/tests/dump-route-activation.test.ts:269`). `/tmp/vnext-d02-route-activation-clean-ci.log:6517,6619` has the multiple-project advisory and 36 lint warnings. Root identifies the warnings as inherited; no lint finding is attributed to a newly added behavior. Capture/assert expected failure logs in tests, or explicitly label simulated timing in retained evidence, as a separate cleanup. These do not invalidate the passing assertions or block activation.

## Unresolved cross-task checks and integration boundary

- **Accepted collector/adapter foundation, not independently source-audited here:** 8-attempt cap, 1 MiB total retained bodies, 16 KiB per-attempt headers, independent 64 KiB metadata/header budget, UTF-8/backing-buffer behavior, enum-only errors, and status-0/Response metadata/clone handling. This task allocates the default accepted collector unchanged (`packages/gateway/src/shared/dump/accumulator.ts:134`); the focused log includes their existing suites. Root must retain the prior foundation approvals; this task review does not replace them.
- **Accepted provider/storage foundation, not independently source-audited here:** six providers' full discovery/OAuth/session/passport/usage/control-plane exclusions, callback failure isolation and SQL/file/broker sidecar failure isolation. The accepted provider/storage suites passed in the supplied focused/clean logs, while the new route suite directly exercises Custom and stored/request-token Copilot. There is no full provider-by-route Cartesian or live-vendor test claim.
- **Protected-dirty integration remains root-owned:** this verdict applies to the frozen clean candidate and the supplied patch. It does not verify subsequent staging/merge of `responses/attempt.ts` with unrelated collaboration edits, preservation of those edits, or any later candidate mutation. No source or Git state outside the report was changed by this reviewer.
- **No unresolved task-local correctness finding.** The items above are dependency and integration ownership boundaries, not requests to rerun already passing suites.

## Assessment

**Task quality: Approved.** The patch activates the accepted observation machinery through explicit request-local state, keeps configured transport selection intact, and provides meaningful persisted-output coverage for the required route matrix and failure/cancellation cases. Root can proceed with its protected-dirty integration while preserving the accepted foundation approvals and the exact frozen validation evidence.
