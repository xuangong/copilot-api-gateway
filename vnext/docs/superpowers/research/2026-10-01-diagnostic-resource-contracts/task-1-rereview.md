Archived from the preserved isolated-worktree evidence directory `.superpowers/sdd/2026-10-01-diagnostic-resource-contracts/`. Relative raw-log paths in this report refer to that directory.

# Task 1 scoped re-review

## Spec Compliance

- ✅ **I1 ADDRESSED.** `vnext/packages/gateway/src/shared/dump/capture-budget.ts:160` observes each phase inside a separate native Promise executor. A throwing input `then` getter or method becomes that phase's rejection; it no longer rejects the aggregate or prevents observing the other phase. `capture-budget.ts:193` passes both isolated receipts to the unchanged two-phase retirement reaction.
- ✅ **Spec outcome: compliant within this scoped re-review.** `capture-budget.ts:192` still memoizes the retirement receipt before either observation can reenter. `capture-budget.ts:168` keeps release after both receipts settle, releases once, and preserves preparation-rejection precedence. The fix does not alter accumulator ordering or capture admission behavior.
- ⚠️ This review covers I1 and new breakage in `0c53ce12..2f0a23e0`, not the final whole-branch qualification. The prior preservation/integration boundaries remain for the controller's final checks.

## Strengths

- `vnext/packages/gateway/src/shared/dump/capture-budget.ts:158`: the fulfillment callback captures only its resolver and explicitly resolves with no value; successful runtime payload values are neither forwarded into the aggregate nor retained through the retirement receipt. Additional wrappers are allocated only at first retirement, not per frame.
- `vnext/packages/gateway/tests/dump-capture-budget.test.ts:188`: the eight-case regression matrix covers either failing phase, a throwing getter or method, and fulfillment/rejection of the other deferred phase. Assertions check immediate observation, retained charge and late admission while pending, eventual retirement, error precedence, receipt identity and post-retirement refusal.

## Issues

- **Critical:** None found in this fix diff.
- **Important:** None found in this fix diff.
- **Minor M1:** Existing multi-tsconfig lint advisory remains recorded in `task-1-evidence/fix-1-scoped-lint.log:1`; deferred by the controller for final review, as instructed. It is not new breakage.

## Checks

- Read the supplied fix diff once and the appended Fix round 1 report. No additional source inspection or focused reproduction was necessary: the per-phase Promise executor directly closes the demonstrated failure, and the new regression matrix discriminates it.
- Read saved evidence, without rerunning tests: `fix-1-green-budget.log` reports 24 pass, 0 fail, 271 assertions; `fix-1-gateway-typecheck.log:1` reports exit 0. Scoped lint records only the existing M1 advisory, and `fix-1-protect.log:1` reports 38 main and 14 isolated protected files matching.
- No source, index, Git state, dependencies, fixture/service or production state was changed. Only this requested re-review artifact was written.

## Assessment

**Task quality:** Approved for this scoped re-review.

**Reasoning:** The fix converts each observation failure into an independent phase outcome while retaining both-phase waiting, preparation precedence and reentrant receipt identity. No new Important or Critical issue was found; this conclusion concerns the source mechanism and recorded focused validation, not measured CPU, memory or latency gains.
