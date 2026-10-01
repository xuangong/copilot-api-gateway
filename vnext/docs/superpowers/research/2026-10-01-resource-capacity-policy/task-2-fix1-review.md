# Task 2 fix 1 independent scoped re-review

Range: `c81e4639..cf3eb4b2`. Scope: prior Important finding and new Critical/Important regressions in the three-file fix only. Reviewed the packaged diff, current changed provider regions, added regression tests, implementation report fix-1 appendix, and RED/GREEN/typecheck/purity/lint evidence logs. No suites or probes rerun; no source/index/commit, service, or network changes.

## Verdict

**PASS for this scoped fix.** Prior finding: **ADDRESSED**. No new Critical or Important findings in this diff. The previous Task 2 spec/quality blocker is resolved within the previously stated qualification boundaries.

## Per-finding disposition

**ADDRESSED — multi-page capacity rejection retired the provider before started sibling fetch/helper settlement.**

At `vnext/packages/gateway/src/data-plane/tools/web-search/providers/jina.ts:285` and `vnext/packages/gateway/src/data-plane/tools/web-search/providers/microsoft-grounding.ts:239`, the provider now awaits `Promise.allSettled` for all eagerly started page helpers. It reconstructs successful outcomes in original URL order and throws the original rejected reason only after the helper set has settled. Therefore the existing provider-plus-usage finally path cannot retire while a sibling helper is still pending. Empty batches, admitted concurrency, ordinary per-page failure handling, retry logic, and usage-finally ownership remain unchanged.

Immediate hosted failure delivery still comes from the unchanged ingress failure latch and scope cancellation. This fix waits only in the real-settlement chain; it does not defer the latch or permit another fallback/model continuation. The original capacity reason remains scope-owned and governs immediate and later delivery. No new telemetry policy is introduced: one aggregate usage attempt in the regression reflects the existing recorder behavior.

The four added real-built-in and SQLite-backed scope cases at `vnext/packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts:425` exercise both Jina and Microsoft, each with a sibling fetch gated to resolve or reject. They verify two starts, immediate original-reason delivery rejection, pending real settlement and absent usage while the sibling is pending, then actual sibling completion, settlement, and exactly one aggregate attempt. They also assert later delivery retains the same reason. This directly covers the formerly unowned nested helper, rather than only separate outer search leaves.

## Evidence assessment

Inspected RED shows all four cases fail specifically on premature `settled === true`, before the fix. Inspected GREEN shows 75 pass / 0 fail, 241 assertions across provider and execution-scope files. Scoped typecheck exits 0; purity reports OK; lint output contains only the existing resolver informational warning. These are inspected implementation-run results, not newly executed reviewer tests.

## Unchanged qualification boundaries

This is source/promise ownership qualification, not evidence of physical I/O termination, workerd execution, whole-isolate memory bounds, measured CFW-safe numeric defaults, performance, full HTTP protocol-owner end-to-end correctness, or deployment readiness. Non-awaited underlying reader cancellation remains explicitly permitted by the original specification. Native Messages and Alpha local retain standalone per-response caps without a new invocation cumulative budget. Task 3 retention, Task 4 diagnostics, protected-overlay verification and root full-CI/freeze remain outside this small re-review. No additional broad review or fresh suite pass is claimed.
