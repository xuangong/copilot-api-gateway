# Task 1 independent implementation review

Verdict: **CLEAN — no actionable correctness, contract-compliance, or scope findings.**

Reviewed commit: `a3eb50537f37928d6729f4ca6e560f9858a948fc`.

Base: `aaa6494257b2f6b3778562a969d45405e726b653`.

Reviewer scope: one combined specification-compliance and code-quality review of Task 1. This review did not implement the change, modify source, run tests, commit, or stage files. It does not review Tasks 2/3, the preserved collaboration overlay, or controller-owned documentation changes. Only this review document was written.

## Inputs and review method

Read `task-1-review.diff`, `task-1-brief.md`, the complete contract-strengthening spec and the plan's Global Constraints/Task 1, followed by current source and `task-1-report.md`. Inspected the existing RED/GREEN, focused-test, purity, scoped-lint and protection logs. Checked that the compile assertions are included by each package's ordinary `include: ["src/**/*.ts"]` tsconfig.

Independently compared all 12 committed Task 1 files with their current worktree bytes. Every file exactly matches the reviewed commit. Independently recomputed all protected SHA-256 values from the manifests: isolated **14/14 match**, main **38/38 match**. The `aaa64942..a3eb5053` changed-file set contains exactly the 12 permitted Task 1 files; no protected path or controller-owned document is included.

## Contract compliance and correctness

### Exact preparation output is derived from actual control flow

`vnext/packages/chat-flow-kit/src/serve-template.ts:152-155` makes `preProcess` mandatory without conditional generic machinery, compatibility overloads, or a second hook family. `RunAttemptArgs.extra`, `RespondCtx.extra`, `BuildTelemetryCtxArgs.extra`, `ReadyTemplateResult.extra` and `ExecuteTemplateResult.extra` are exactly `TExtra` (`serve-template.ts:103-118,167-175,195-210`). Early response and outer serve results still allow `undefined` (`serve-template.ts:188-191,208-210`).

The implementation always awaits preprocessing inside the original preparation error boundary, returns a short-circuit before constructing readiness, and takes `payload`/`extra` from the narrowed continue result (`serve-template.ts:281-297`). There is no cast to `TExtra` or missing-extra assertion. Passing `TExtra = undefined` remains valid and explicit no-op fixtures preserve the same payload reference.

All four production hooks already had preprocessing. The production hook bodies and their ordering are unchanged. The default kit fixture and exactly two direct dump fixtures now explicitly return continue with `extra: undefined`; the concrete-extra fixtures still produce concrete extra. No compatibility shim was added for the historical research probe.

### Gateway prepared identity and optional fields remain honest

`vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts:31-40,73-85` types its dependency input as `PreparedModelIdentity`, removes the unknown-record lookup, and preserves the object and invalid/empty string runtime guards. The dependency still consumes only the minimum identity field; endpoint-specific routing extra is not copied or replaced.

Each protocol replaces only optional access on the now-required outer extra. Field-level optionality remains intact, including affinity, upstream pin, history and completion writer. Gemini's redundant absent-extra guard is removed while its required routed model and optional pin retain their original use. This is consistent with the new ready contract and does not change routing or authorization behavior.

### The observer remains synchronous and before execution

`vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts:72-83` introduces the exact named `ResponsesPreparedObserver` contract. It returns `undefined` and presents a top-level readonly record. The observer invocation remains after history/compaction preparation and before model routing/affinity; no `await`, detached task, clone or runtime Promise inspection was introduced. Existing synchronous exceptions retain the same preparation catch and response envelope.

The only helper annotation change is the readonly `create` input to `ResponsesLocalContinuation.candidate`; its serialization and replay behavior are unchanged. The session observer is unchanged. The readonly guarantee is accurately limited to the declared view, not deep immutability or runtime isolation.

The new Responses tests exercise both normal generation and warmup: the observer sees the incoming model, throws a 413 admission envelope, and neither generation nor warmup validation is entered. Spies are restored in `finally`; no module/SQLite mock was added.

### Prior order, identity and single-use contracts are preserved

Preparation still orders parse -> requested-model stamp -> preprocessing -> stream choice -> telemetry -> quota (`serve-template.ts:261-315`). Parse/preprocess failures and preprocessing short-circuits return before telemetry/quota/attempt. Quota retains the prepared extra and returns before capability creation.

`createReadyTemplate`, abort linking, synchronous `pendingRunner` consumption, original runner binding, execution rejection propagation and existing serve/Responses lifecycle owners are unchanged (`serve-template.ts:212-245,317-350`). No provider dispatch, result conversion, cancellation policy, continuation barrier, diagnostic owner or retry policy was added or moved. The stronger extra annotations do not copy payload/auth/side-input references.

## Evidence assessed

- Core RED typecheck contains the six intended TS2344 contract failures; gateway RED contains four intended observer contract failures. No missing-import diagnostic substitutes for a meaningful RED check.
- GREEN kit and gateway package typechecks exit 0. The normal source-included type tests cover required preprocessing, each exact successful extra, explicit undefined extra, early/outer optional extra, named observer equality, minimum gateway identity, async/void rejection, and readonly index-signature input.
- The retained combined focused log reports **191 pass, 0 fail, 880 assertions across 10 files**: kit, four protocol serve suites, Responses SQLite session, session limits, turn barrier and two dump suites. Its scope matches Task 1's plan.
- The pre-change observer characterization log reports 4 passing tests, appropriately demonstrating preservation of existing synchronous behavior rather than claiming a new runtime fix.
- Framework purity passes. Scoped lint exits 0 with no errors and one unchanged unused-import warning in `dump-accumulator.test.ts`; that import is outside the Task 1 diff.
- The implementation protection log verifies the historical retention probe remains unchanged. My independent verification additionally covers both complete 14-file isolated and 38-file main manifests and exact current Task 1 source identity.

The runtime/typecheck results above are inspected implementation evidence, not reviewer-rerun results. No source suspicion required repeating those checks. No full CI, benchmark, deployment, or performance claim was made during review.

## Disposition

Task 1 satisfies its specified source and focused-verification requirements and can proceed to combined qualification with the other tasks. The controller's final frozen-artifact CI, complete-branch review and local-integration checks remain separate gates. No revision request is required for this task.
