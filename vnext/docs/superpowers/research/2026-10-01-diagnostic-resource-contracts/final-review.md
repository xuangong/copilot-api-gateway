Archived from the preserved isolated-worktree evidence directory `.superpowers/sdd/2026-10-01-diagnostic-resource-contracts/`. Relative raw-log paths in this report refer to that directory.

# Diagnostic resource contracts: final independent review

Date: 2026-10-01.

**Ready for local qualification: Yes.** No open Critical or Important finding was identified in the combined change. This is readiness to freeze and qualify the local artifact, not a completed CI, integration, deployment, or production-effectiveness verdict.

## Scope and method

- Base: `f6797d50a797a2633d60128593861349038f0300`.
- Reviewed HEAD: `ccc92ab2921c26023b91daea7c7d8a295f419860`, confirmed with `git rev-parse HEAD` in the supplied isolated worktree.
- Read the supplied whole-batch diff, including source, tests, plan, specification, capacity audits, contract/follow-up matrices and archived task reviews. Read `progress.md`, including Task 1 I1 resolution and the deferred Minor advisory.
- Followed the supplied `requesting-code-review/code-reviewer.md` review template. No delegation was used.
- Additional source inspection was limited to named combined risks: accumulator first-terminal ownership and retirement call sites; its preparation/build/store/publication chain; the SSE subscriber's eager acquisition and final cancellation; and existing SQLite phase/accounting assertions relied upon by the task reports.
- Read the retained focused-test summaries, Task 1 observation-regression output, successful gateway typecheck/purity outputs and both lint advisory logs. No test suite or behavioral reproduction was run: the diff and focused call-site inspection resolved the review questions without duplicating prior tests.
- This report is the only artifact written by this review. No source, index, HEAD, branch, dependency, fixture, service, network, production, benchmark, push or deployment operation was performed.

## Strengths

1. **Admission and release authority are distinct at runtime and in types.** `vnext/packages/gateway/src/shared/dump/capture-budget.ts:72` defines the capture view and scope, while `:98` keeps the shared counter behind ECMAScript private state. The module-local facade cannot release or retire its scope, and the public budget no longer exposes raw reserve/release operations. Type assertions and runtime `in` checks exercise the actual authority boundary (`src/shared/dump/__tests__/capture-contract.test.ts:5`; `tests/dump-capture-budget.test.ts:4`). Existing estimation, limits and omission semantics are preserved.

2. **Retirement binds one receipt before observing either phase.** `capture-budget.ts:188` memoizes ownership before possible synchronous `then` reentry. The independent native observation receipts at `:160` convert a throwing getter/method into that phase's rejection without skipping the other phase. The final reaction at `:168` waits for both outcomes, releases once, preserves preparation-error precedence and refuses later admission. It retains scalar accounting plus the void receipt rather than successful payload results. The new phase-order/rejection matrix and the eight observation-failure cases discriminate these properties (`tests/dump-capture-budget.test.ts:107`, `:188`). The previously reported Important I1 is resolved in the reviewed HEAD.

3. **The accumulator remains the terminal owner.** `vnext/packages/gateway/src/shared/dump/accumulator.ts:183` stores the owner and capture view separately, and `:215` changes only the retirement delegation. Its existing `terminalWrite` guards and already-started work remain authoritative for abandon, turn finalization, response drain and canonical transport (`:303`, `:334`, `:406`, `:431`, `:498`). Admission remains possible during the pending drain; selecting retirement neither stops that drain nor invents a request completion. The existing normalized preparation receipt at `:192` also keeps diagnostic preparation failures within their established boundary.

4. **Persistence still precedes optional live delivery.** `accumulator.ts:113` attaches publication only to fulfilled `store.put`, with diagnostic-only failure handling. The broker's early return therefore removes no storage work and cannot convert notification failure into inference replay or rollback. The new real-store handoff test captures committed rows and owned-file states during encoding, then asserts them outside the best-effort callback (`tests/dump-terminal-handoff.test.ts:329`). Existing SQLite assertions independently cover retained charges during preparation, upload and publication (`tests/dump-capture-budget.sqlite.test.ts:146`) and failure/cancellation release paths (`:183`, `:210`, `:228`).

5. **Subscription ownership and consumer termination now agree.** `vnext/packages/gateway/src/shared/runtime/event-target-channel-broker.ts:16` acquires eagerly; `:26` releases only the matching entry at the last subscriber. Closing removes the old map entry before notifying listeners (`:39`), protecting a recreated same-ID channel. The common termination path at `:77` distinguishes graceful FIFO draining from cancellation, resolves a pending read, and retains abort observation only while residual data needs drain/cancel. One shared iterator and explicit second-pending-read rejection avoid displaced consumers; the post-decode closed check handles synchronous cancellation. These semantics fit the existing SSE route, which subscribes before its snapshot read and aborts on snapshot failure or stream-finally cleanup (`src/control-plane/dump/routes.ts:108`, `:135`).

6. **Documentation distinguishes adopted contracts from deferred capacity policy.** The accepted specification and `channel-broker-contract.ts:10` explicitly declare the no-recipient encoding change and sequential consumer behavior. Historical audits are marked as baseline evidence, and the earlier architecture paragraph receives a dated update. The follow-up matrix keeps operation admission, success-body ingestion, replay retention, publication counts, active subscriber queues and workerd/rollback qualification open. No new numeric limit, storage schema, environment variable, retry, clone/freeze policy, native JSON behavior, tool-loop reentry or continuation/completion owner is introduced by this diff. Source mechanisms are not presented as measured CFW savings.

## Issues

### Critical (Must Fix)

None found.

### Important (Should Fix)

None found. Task 1's earlier I1 is closed by the independent phase-observation receipts and their regression coverage; it is not an outstanding final-review issue.

### Minor (Nice to Have)

**M1 — Existing multiple-tsconfig lint advisory remains deferred.**

- References: `.superpowers/sdd/2026-10-01-diagnostic-resource-contracts/task-1-evidence/fix-1-scoped-lint.log:1` and `task-2-evidence/scoped-lint.log:1`.
- Both logs contain the resolver advisory about multiple projects and possible use of project references or warning suppression. The recorded commands succeeded and emitted no source lint diagnostic.
- This affects tooling output/performance clarity, not the implemented resource contract. Retain it in final qualification rather than claiming warning-free validation. Review resolver project selection when tooling is next changed; do not expand this source increment merely to silence it.
- Disposition: explicitly read and triaged; nonblocking for local qualification.

## Validation evidence and limits

| Recorded check | Evidence reviewed | Interpretation |
| --- | --- | --- |
| Task 1 original focused suite | `task-1-evidence/focused-tests.log`: 110 pass, 0 fail, 795 assertions across five files | Baseline implementation evidence before I1 correction; not a final whole-artifact result |
| Task 1 corrected budget suite | `task-1-evidence/fix-1-green-budget.log`: 24 pass, 0 fail, 271 assertions | Includes phase order, reentry and all eight observation-failure regressions |
| Task 2 final focused suite | `task-2-evidence/focused-tests.log`: 102 pass, 0 fail, 536 assertions across four files | Covers broker, control-plane dump, terminal handoff and accumulator after both task source changes |
| Gateway types and purity | Both final task typecheck logs report exit 0; Task 2 purity reports `[framework-purity] OK` | Recorded focused validation, not a rerun by this reviewer |
| Scoped lint | Both final lint logs contain only M1's advisory | No source diagnostic; advisory remains disclosed |

The controller still owns fresh verification of the original 38 main and 14 isolated protected files, complete source-manifest equality in both checkouts, and fixture PID/start-time preservation. This review did not substitute archived protection results for those final checks. The final complete `ci:local` has not yet run for the frozen combined artifact.

## Recommendations

1. Freeze the reviewed non-document source/configuration/tests together with the protected overlay, then run the planned single complete `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` qualification.
2. After success, perform the controller-owned post-CI hash checks, authorized local `vNext` fast-forward, both complete manifest comparisons, original 38/14 protected-file checks and fixture preservation check. Keep closeout documentation separate from qualified source.
3. Record final qualification against that exact artifact and retain M1 plus the explicitly deferred active-queue/publication/search capacity and workerd/rollback gates. Successful local tests or Workers bundling must not be recast as production effectiveness or measured CPU, heap, memory or latency improvement.

## Assessment

**Ready for local qualification: Yes.** The combined change preserves the existing accumulator/storage/completion progression while narrowing accounting authority and making channel lifetime follow subscriptions. No further source fix is required by this review before the planned qualification gate; final CI and artifact-preservation checks remain required before the controller's local integration verdict.
