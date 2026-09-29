# D08 capacity ordering discrepancy — independent read-only review

Recommendation: accept the proposed narrowly recorded comparator-tie exception for the capacity slice, provided it is described as a deliberate compatibility qualification with observable presentation consequences. Do not describe the three responses as exact JSON parity or the change as having no UI effect. No product edit is justified merely to reconstruct the old query planner's incidental tie order. This recommendation does not waive any value/accounting equality gate.

The initial review's strict final-array parity conclusion was supported only by its focused fixtures. Root's independent large-fixture discovery supersedes that conclusion for the three identified SQLite/high/viewer responses. The capacity implementation still preserves the existing comparator, but it does not preserve every old array position.

## Evidence and mechanism

Read root's `task-D08-capacity-ordering-proof.json`, its `d08-acceptance/inspect-ordering.ts` checker, the HTTP whole-load runner, and current unchanged server/frontend consumers. No runtime or tests were started and no product files were edited.

The recorded proof reports:

| Response | Rows | Changed positions | Complete row multiset | Changed positions compare equal |
| --- | ---: | ---: | --- | --- |
| today | 1,464 | 4 | exact | yes |
| 28d | 40,069 | 16 | exact | yes |
| strip | 167,021 | 20 | exact | yes |

The checker verifies equal lengths, each array's nondecreasing order under the actual five-field comparator, comparator equality at every changed position, and the full canonical row multiset including all values. It does not normalize Unicode, merge categories, discard fields or introduce numerical tolerance. Its current source also checks captured bodies against the recorded run hashes. This is review of root's evidence/checker, not an independently rerun measurement. Root reports the other 32 successful original/repaired endpoint hashes exact and all repaired runtime pairs exact.

`aggregateUsageForDisplay` groups with raw JSON tuple identity, then sorts by localeCompare for hour, keyId, incomingModel, model and client (`packages/gateway/src/control-plane/token-usage/aggregate.ts:65-80`). Distinct raw strings such as precomposed/decomposed accented names can compare equal. Final tie order therefore comes from the input/map insertion order. Both old and new repository queries specify only ORDER BY hour; root's EXPLAIN evidence attributes the changed input order to old high-cardinality placeholder selection using the hour index versus JSON-scope selection using the identity index plus hour sort. The product comparator itself was not changed.

Both arrays can satisfy that comparator while failing exact array equality. The new result is not evidence of a missing row, merged Unicode identity or accounting-value mutation in these three captured responses.

## Actual consumer consequences

This exception is not completely presentation-neutral:

- `state/usage.ts:466-520` constructs chart series in first-seen Map order. When filters expose client or model grouping, the two distinct Unicode identities can exchange first appearance, legend/dataset order and palette assignment. `tabs/usage/UsageTab.tsx:62-65` assigns color by array index. An unfiltered key-grouped fixture alone cannot exclude this filtered-view effect.
- `state/usage-model-dimensions.ts:135-140,150-173` sorts distributions by token total then localeCompare(label). Equal totals and collator-equal labels preserve first-seen order. `UsageDistributionTable.tsx` uses row index for color, so tied distribution rows can also exchange colors/order.
- Identity and filter membership remain raw-string based (`filterUsageRows`, lines 94-105); the API adapter preserves the values and relative order. This does not silently combine the two categories. Client/model/incoming-model filter options use default string sort, so their option membership/order is not directly dependent on the changed encounter order.
- Participants are a separate unchanged exact-array contract. Nothing about this finding justifies relaxing owner/assignee ordering or fields.

There is also a precision boundary, not a demonstrated numeric defect: summary, chart-cost and daily-strip reducers add floating-point costs in encounter order (`state/usage.ts:407-415,491-501,527-539`). Exact row multisets do not by themselves prove bitwise identical reduced sums. The supplied HTTP whole-load runner awaits families and records their responses; it does not execute those React reducers or forecast calculations. No current numeric regression is asserted here. If strict reducer/chart/strip/forecast numeric equality remains a required gate, compare those outputs from the retained arrays offline and reject any difference under this order-only exception. Do not silently add a numeric tolerance or infer reducer equality from the row-multiset proof.

## Alternatives and minimum scope

1. Reproduce the previous physical tie order. An index hint for the high scoped case, a cardinality branch, or explicit rowid ordering would couple the repair to one observed planner choice. The original low/admin/runtime cases can use different access paths. No single such rule has been shown to reproduce all old cases, and it can undo capacity/scan benefits or alter additional orders. This is not the smallest robust compatibility repair.
2. Add a deterministic raw-string tie-break to the existing final comparator. This is a small source change and a reasonable separate ordering design, but it establishes a new order; it does not reconstruct an old order that was never total. It can also change presently exact cases and still changes colors. It would require a new product freeze and explicit acceptance. It is not needed to resolve this capacity slice if the root accepts the documented tie exception.
3. Normalize Unicode identity or sort every oracle result without constraints. Reject. Normalization can merge distinct model/client IDs; unconstrained sorting hides real ordering regressions. Neither is warranted.
4. Keep the product comparator and record the narrow exception. This has the smallest implementation scope and is reasonable given exact full-row equality plus comparator-order evidence, with the explicit visual tradeoff above. Deterministic ordering can be established later in C2 under its separate contract.

## Required wording and guardrails for the ruling

Use: “Exact successful JSON parity except three identified legacy detail arrays, which preserve every complete row and the existing comparator order but permit permutation only inside complete comparator-equivalence groups. Canonically equivalent spellings remain distinct identities; first-appearance legend/order/color can differ.”

The exception should apply only to top-level detail rows. Preserve all nested arrays, all participants arrays, all fields and numbers, row multiplicities, endpoint status and authority behavior. Require old and new arrays to be nondecreasing under the exact existing comparator and every changed position to remain within the same comparator-equivalence class. Do not use independently equal single labels to justify moving rows across a different hour/key/incoming/model/client group. Retain the original hashes and the three failing exact comparisons beside the qualified proof rather than overwriting them as exact passes.

Under those conditions the proposed root ruling is an acceptable explicit design decision, not a claim that strict compatibility was achieved. Full CI and capacity success are separate from this waiver. Actual downstream numeric parity and browser-observed visual extent remain unverified by this read-only review; the acknowledged potential palette/legend exchange is the known cost of accepting the exception.
