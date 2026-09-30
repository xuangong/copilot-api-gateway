# Task 3 independent review

Date: 2026-09-30. Reviewer: `subsystem_control_review`.

**Verdict: approved for the integrated candidate.** No blocking issue established in the reviewed quota projection and admission path. This is a scoped source/test review, not production or whole-runtime resource qualification.

## Scope and reasoning

Reviewed the five files in `task-3-report.md`, the original usage bucket assembler, dimension persistence, `unitPriceForDimension`, `recordCostUsd`, the shared weighted-token formula, and the aggregate's consumption by `checkQuota`.

- SQL bindings preserve key and half-open UTC hour scope. The fallback lookup uses the complete original bucket identity, including incoming model, target model, null-normalized upstream, model key, client and hour.
- Fallback matches the existing input-cache/input-image to input and output-image to output semantics. `COALESCE` keeps a recorded zero price. Unknown dimensions do not affect weighted tokens or known cost, while independent request buckets are still counted.
- Request-only admission avoids dimension reads; token-only admission avoids pricing and request-count reads; no-quota admission does no usage work. The shared repository owner implements the operation once for SQLite and D1.
- The aggregate materially bounds the ordinary result shape and avoids creating every `UsageRecord` in the Worker. It does not bound D1 scan work or the complete heap.
- The floating-point threshold fallback deliberately keeps the legacy ordered JS calculation for the tested reassociation-sensitive token/cost boundaries. Its metadata and detail exception are explicit in the type and implementation report. Request/token/cost reason precedence, retry timing and the existing outer fail-open behavior are preserved.
- The fallback can still materialize a full month near a threshold. This is a documented compatibility tradeoff, so the change must not be described as a hard memory bound for every quota admission.

The snapshot/authority migration is coordinated correctly: API-key configuration uses `getDataPlaneConfiguration`, and usage reads stay on `getRepo()` authority.

## Independent validation

Run from `F/vnext`:

```text
bun test packages/gateway/tests/repo-quota-projection.sqlite.test.ts packages/gateway/tests/repo-usage.test.ts packages/gateway/tests/observability/quota.test.ts packages/gateway/tests/observability/dispatch-quota.test.ts

33 pass
0 fail
116 expect() calls
Ran 33 tests across 4 files. [843.00ms]
exit 0
```

The tests execute real SQLite, including identity isolation, nullable/empty upstream equivalence, zero and unresolved prices, unknown dimensions, image/cache weights, independent request/token buckets, inclusive/exclusive bounds, one-row result shape, real fail-open behavior, denial precedence and floating-point admission examples. The real dispatcher still returns 429 for an exceeded quota.

## Scoped follow-up review

The implementation owner addressed the optional request-first short-circuit: an already-exceeded request quota returns after the aggregate, before unrelated token/cost precision fallback. The post-fallback request check remains for a later usage snapshot. Reviewed that delta and its new real SQLite regression; approval is unchanged.

```text
bun test packages/gateway/tests/repo-quota-projection.sqlite.test.ts -t 'request.*|denial order|exact token'

5 pass, 9 filtered out, 0 fail, 22 assertions
exit 0
```

The new regression confirms one result row when requests are exceeded and both token/cost values lie exactly on their thresholds. The implementation report's final complete focused run is now 34 tests; the review's independent complete run above covered the preceding 33-test artifact, followed by this independent five-case delta check.

D1 query-plan/scan cost and realistic local-workerd CPU/heap measurements remain the next exact-artifact performance gate. This reviewer did not run full CI, install dependencies, mutate Git, deploy, or change product/test source for Task 3.
