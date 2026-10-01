# Resource capacity policy evidence

Date: 2026-10-01. Implementation in progress; these are design inputs, not completed qualification.

- [Binding specification](../../specs/2026-10-01-resource-capacity-policy.md)
- [Implementation checklist](../../plans/2026-10-01-resource-capacity-policy.md)
- [Hosted-search policy design](search-capacity-design.md)
- [Diagnostic policy alternatives](diagnostic-capacity-design.md)
- [Next workerd runner readiness](workerd-readiness.md)

The specification selects the first diagnostic slice: bounded server delivery plus explicit latest refresh. The broader polling/history-window design remains unimplemented. Design default rationale does not establish production safety or measured CPU/memory improvements. No deployment occurs in this increment.
