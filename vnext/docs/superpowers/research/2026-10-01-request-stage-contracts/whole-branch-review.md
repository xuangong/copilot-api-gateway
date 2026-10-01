# Request stage contracts: final whole-branch review

Date: 2026-10-01.

Reviewed product range: `8451196284a6c5f501f8b7e00a376bbd3009848f..717cd86e3a64af063c3f59c1a721c3aa31cf5b35` in `.worktrees/cfw-resource-rollback-fix`. HEAD was independently confirmed at the latter commit. The review also includes the current stage spec, implementation plan, prior-batch research README correction, and the new implementation/qualification README records. The preserved collaboration overlay is outside the code-review change scope, but is included in the recorded CI artifact.

The implementation and surrounding ownership paths were inspected independently before reading the task implementation report or earlier review conclusions. No product source, index, branch, running service, or deployment was changed by this review.

## Assessment

**Specification compliance: approved. Code and architecture quality: approved. Ready for the authorized local integration: yes.**

No outstanding Critical, Important, or Minor defect was verified in the reviewed change. The preparation/execution split is real, the typed endpoint inputs are used by all four native adapters, and the original serve/turn owners retain cancellation, diagnostics, transport and completion. The earlier Important/P2 retained-request finding is corrected at the reviewed head and independently closed by the scoped re-review.

This is local integration readiness for the qualified source plus its preserved overlay. It is not a production-release or deployment verdict, and does not certify a clean checkout without that overlay. The actual fast-forward and post-integration preservation check remain the controller's next operation at this review boundary.

## Strengths and integrated contracts

1. **The reference adoption changes behavior at a meaningful boundary.** The reference's `OpenAIResponsesServePlan` separates a preparation failure from readiness before calling inference. The local reference checkout identifies `1d7dcd923e260e425120cca0c7a240e93720af27`; its preparation plan and typed `GatewayCtx`/`ChatGatewayCtx` substantiate the two selected mechanisms. vNext now returns `response | ready` from `prepareTemplate`, ending after the existing quota gate (`vnext/packages/chat-flow-kit/src/serve-template.ts:247-334`). Neither attempt nor response is invoked during preparation. Routing remains with the native attempt rather than being moved to mimic the reference's candidate preparation mechanically.

2. **Execution authority is request-local and single-use.** The module-private symbol and original bound runner form the handoff (`serve-template.ts:193-244`, `:325`). The runner is cleared synchronously before cancellation linking and invocation, so concurrent, completed, and rejected repeat consumption cannot start another attempt. `executeTemplate` accepts no replacement hooks, auth, dependencies, or payload. Rejection identity remains intact. There is no plan registry, replay cache, retry owner, or per-frame work.

3. **The data contracts preserve actual ownership.** `TInputs` is threaded through all hook/input/result contexts, distinct from preprocessing output and auth (`serve-template.ts:71-164`, `:195-210`). Responses declares continuation/warmup/prepared-callback/request/action inputs (`responses/serve.ts:119-131`); Messages declares inbound headers (`messages/serve.ts:59-68`); Gemini declares URL model and stream intent (`gemini/serve.ts:61-70`); Chat Completions explicitly declares no side inputs (`chat-completions/serve.ts:60-70`). The corresponding dictionary casts are removed. `RespondCtx.extra` now honestly permits absent preprocessing. Payload, auth, telemetry, timestamp, dump, side-input and controller references are passed through without a new copy.

4. **Cancellation and exceptional cleanup keep their existing owners.** Preparation installs no kit-owned inbound listener. Execution uses the isolated linker (`serve-template.ts:212-217`, `:234`), preserving already-aborted reason identity, the supplied-controller guard, and cancellation after the attempt returns. Ordinary serving still composes prepare/execute/respond/finalize inside `withDumpExceptionCleanup` (`:337-353`); its cleanup preserves the original exception even if abandonment throws or rejects. Canonical completion still transfers with the exact response. The capability itself neither finalizes diagnostics nor publishes continuation.

5. **Responses keeps one turn owner across the new handoff.** Both calls are inside the original deferred callback (`responses/serve.ts:252-266`), with the same downstream/upstream controllers and completion unlink. Warmup still selects validation, compact still forces JSON, and `onPrepared`, local continuation, retention, and request identity are unchanged (`:149-190`, `:217-230`, `:270-301`). The existing turn still closes raw sources, awaits an in-flight continuation save, and resolves facts/receipts/completion (`responses/turn.ts:340-398`). `persistCompleted` precedes reusable success and terminal delivery (`:472-484`); no second completion or persistence owner was added.

6. **Protocol and policy boundaries remain intact.** Parse, requested-model stamping, preprocessing/history, stream choice, telemetry and quota remain in their original order (`serve-template.ts:261-318`). Previous-response failures retain their protocol envelope before quota (`responses/serve.ts:149-213`). The attempt result and response context cross the handoff unchanged. Native response rendering, the producer-domain assertion and separate translated JSON/event paths (`responses/source-result.ts:20-49`), single-consumer delivery, candidate eligibility/materialization, and existing attempt retries are not changed by this range. No schema, environment, admission-policy, storage-semantic, or retry-policy change is hidden in the stage extraction.

## Findings

| Severity | Outstanding verified findings |
| --- | --- |
| Critical | None |
| Important | None |
| Minor | None |

The historical Important/P2 finding at the former nested abort callback is **resolved**, not waived. At the current `serve-template.ts:213-217`, the listener is created in a module-level helper whose parameters are only signal/controller. The call at `:234` does not pass prepared request state. The scoped re-review independently reproduced payload collection without abort on local Node v26/V8 and Bun 1.3, and verified nine cancellation cases. This whole-branch review confirms the structural correction and relies on that scoped runtime evidence instead of duplicating the GC experiment.

## Validation evidence

The controller ran final `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local`; this reviewer inspected its completed `ci-local.log`, including the new contract/cancellation tests and final gate output.

| Evidence | Result and provenance |
| --- | --- |
| Final full CI | 5616 pass, 1 existing skip, 0 fail; 236023 assertions across 535 files. Controller execution, log inspected here. |
| Framework purity and workspace typechecks | Purity OK; every reported workspace typecheck exited 0. Log inspected here. |
| Lint, builds and Worker dry-run | 0 lint errors/34 warnings; setup/dashboard build and Worker dry-run completed, final dry-run exit 0. Log inspected here. |
| Focused implementation qualification | Report records RED behavior failure; 86 protocol/ownership and 50 session/fallback tests, followed by 79 tests after the linker fix. Not independently rerun in this review. |
| Scoped fix qualification | Approved re-review records local Node/Bun reachability matrix and 9 passing cancellation tests/29 assertions. Not independently rerun here. |
| Frozen artifact | Independently recomputed all 1551 hashes in `qualification-source.json`: zero mismatches; manifest source is the reviewed head. |
| Preservation | Independently recomputed 14 isolated overlay hashes and 38 main-checkout protected hashes: zero mismatches. |
| Diff hygiene | Reviewed source-range and scoped documentation `git diff --check` passed. |

No broad test suite was rerun by this reviewer. The one runtime X25519 test skip and existing lint warnings are recorded qualification limits, not defects introduced by this change.

## Documentation and limits

The specification, layer/ownership table and research records match the implementation. They explicitly distinguish typed preparation/execution from later interceptor contracts, call-local translation state and settlement interfaces. The earlier research README now correctly states that its previous result union had not yet separated inference. Borrowed references are documented as requiring caller immutability; the readonly container is not claimed to deep-freeze data. Pending integration checkboxes accurately reflect remaining workflow, rather than a missing product behavior.

This slice adds closure/state and an asynchronous handoff per request. The focused reachability evidence verifies a particular local retained-reference path; it does not measure total retained bytes, latency, CPU, a whole-service memory reduction, workerd capacity, or production behavior. No live upstream, production deployment, clean-install/Docker build, or mixed-version rollback qualification was performed by this review. The documents correctly retain those operational gates and the separate collaboration-overlay disposition before a release claim.

No additional product change is required by this review. Proceed with the authorized local fast-forward and its final equality/preservation checks, then close the qualification record with the actual integration result.
