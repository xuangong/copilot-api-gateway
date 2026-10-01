# Resource capacity policy evidence

Date: 2026-10-01. All four tasks, independent reviews, one fresh complete CI and local vNext integration are complete. CI: 5,880 pass / 1 skip / 0 fail. This is local source qualification, not release or performance acceptance.

- [Binding specification](../../specs/2026-10-01-resource-capacity-policy.md)
- [Implementation checklist](../../plans/2026-10-01-resource-capacity-policy.md)
- [Hosted-search policy design](search-capacity-design.md)
- [Diagnostic policy alternatives](diagnostic-capacity-design.md)
- [Next workerd runner readiness](workerd-readiness.md)
- [Current catalog/affinity rollback readiness](rollback-readiness.md)

The specification selects the first diagnostic slice: bounded server delivery plus explicit latest refresh. The broader polling/history-window design remains unimplemented. Design default rationale does not establish production safety or measured CPU/memory improvements. No deployment occurs in this increment.

## Task evidence

| Task | Source head | Focused verification | Independent review |
| --- | --- | --- | --- |
| Operation admission | 54289f3c | 96 pass | [Approved](task-1-review.md) |
| Successful ingress and settlement | cf3eb4b2 | 206 pass; 75-pass settlement fix scope | [Initial](task-2-review.md), [fix approved](task-2-fix1-review.md) |
| Retained replay/cache/continuation | 0cab1afa | 243 pass | [Approved](task-3-review.md) |
| Diagnostic live capacity and recovery | d94ec4a8 | 128 pass | [Approved](task-4-review.md) |

These suites overlap; their counts are not a summed independent test total. See the per-task implementation reports for commands, RED/GREEN evidence and exclusions.

- [Whole-increment architecture review](whole-review.md): no Critical/Important findings.
- [Final fix report](final-fix-report.md) and [scoped approval](final-fix-review.md): both selected Minor findings addressed at 3ad2d0f1.

- [Final qualification, integration and remaining gates](qualification.md) with [machine-readable receipt](qualification.json).
