# Subsystem contract refactors: implementation record

Started: 2026-09-30. Implementation closeout: 2026-10-01. Implementation baseline: local `vNext` `57501ed3` plus the separately preserved collaboration overlay. This record follows the [implementation plan](../../plans/2026-09-30-subsystem-contract-refactors.md) and [quality attribute design](../../specs/2026-09-30-vnext-quality-attribute-architecture.md).

## Architectural direction

Keep the modular monolith. Strengthen the boundaries that carry authority, state lifetime and completion semantics rather than introduce more services or packages. Shared configuration supplies only admission/routing reads; current commands and credential recovery stay explicit. Catalog retention belongs to its cache owner. Translation describes its actual producer independently of telemetry. Execution facts precede optional projection receipts, while existing compatibility completion remains the transport contract.

The reference project informs exhaustive provider registration and explicit preparation/result declarations. It does not establish that the reference is faster, or justify replacing native JSON, weakening affinity, changing auth policy or bypassing continuation durability.

## Deliverable status

| Deliverable | Status | Evidence and boundary |
| --- | --- | --- |
| Catalog aggregate retention | Complete; local `vNext` commit `b35ad768` | 47 tests; two reviewed race fixes; 64 concurrent reads complete with exactly 64 authority reads even when payload retention rejects the catalog |
| Configuration authority and logout | Complete; local `vNext` commit `4eb47046` | 87 affected tests; independent review with 4 targeted tests; narrow read port and exhaustive mutation classification |
| Quota projection | Complete; local `vNext` commit `82ef31c5` | 34 tests / 118 assertions; independent review and request-priority follow-up approved; near-threshold legacy numeric recheck |
| Producer and completion contracts | Complete; local `vNext` commit `8517f93b` | 514 affected tests plus 174 final affected tests; independent cleanup re-review approved; preserve JSON/event adapter differences and WS compatibility completion |
| Provider/preparation declarations | Complete; local `vNext` commit `75a0973a` | Exhaustive known kinds supply actual lookup; existing preparation union named; 115 focused tests and 19 final factory/proxy delta tests; root review approved |
| Capture/publication ownership | Partial overall; retained-payload slice complete in `15404d95` + `9e54b9a2` | Initial 190 affected tests and 17 boundary tests; final exceptional-exit correction passed 169 affected tests and independent re-review (41 tests). Explicit whole-payload omission and idempotent abandonment; publication concurrency remains a follow-up. Provider-kind hydration fix complete in `00149a35` (31 tests) |

## Compatibility decisions

- Catalog limits apply to coordinator-owned shared retention, not accepted catalog validity. Large catalogs may cause extra authority reads. Estimates are not measured heap usage.
- The configuration contract excludes writes at both the public type and runtime object surface. Credentials continue to use renewable/current state rather than request-pinned authorization rows.
- Quota aggregation preserves bucket-local price fallback and known-zero semantics. SQL regrouping can change floating-point rounding; a conservative near-threshold check falls back to the legacy detail calculation. This deliberately retains the old cost only near numeric decision boundaries.
- HTTP delivery and full settlement are different milestones. Required continuation commit and source-terminal checks remain ahead of reusable success; WS must keep waiting on compatibility completion.
- Capture admission covers retained payload, with defaults of 4 MiB estimated / 8192 frames per capture and 16 MiB estimated environment reservations. Preparation starts only after reservation and keeps it through store/publication settlement. Overflow is visible metadata, never an inference error or an apparently complete partial payload. Metadata-only writes preserve existing best-effort behavior, so their concurrency remains unbounded; ingress/materialization, tee queues and encoder/compression scratch also remain outside this owner. Admitted diagnostic frames retain a bounded plain-JSON projection, avoiding hidden/symbol object graphs; this adds traversal and container-copy work when capture is enabled, which must be included in the later resource comparison.

## Decisions and their costs

| Decision | Reason | Cost or consequence if the assumption is wrong |
| --- | --- | --- |
| Keep modular ownership inside the monolith | The findings concern authority, lifetime and repeated work; separate services would add recovery and coordination contracts | Logical boundaries still share CPU, heap and storage; resource contention must be qualified |
| Preserve legacy floating-point quota decisions with a near-threshold detail recheck | SQL regrouping can otherwise change allow/deny results | Rare requests still perform the original unbounded detail fold; a missed rounding envelope would be a quota compatibility defect |
| Separate bounded catalog ordering heads from payload retention | Payload eviction must not erase publication/incarnation ordering or repeatedly invalidate concurrent reads | Up to 512 small identity heads remain retained; wrong fences could either admit stale authority or add rereads |
| Adapt the existing collaboration shim separately and stage only Responses attempt cleanup hunks | The original workspace contains unrelated uncommitted collaboration/diagnostic work that must survive | The tested artifact includes a separately preserved overlay; its new compatibility regression remains untracked alongside the shim |
| Release the actual upstream body as well as the iterator on producer rejection | An unstarted async generator does not run its finally on return | A bounded cleanup wait exists on exceptional paths; legacy custom results without a disposer retain the existing controller fallback |
| Complete the retained-payload slice before publication-slot admission | A strict slot cap needs visible behavior when no diagnostic record can be accepted | Task 6 remains partial; metadata-only write concurrency and other listed resource domains remain uncapped |
| Retain a bounded JSON projection for diagnostics | Enumerating ordinary object properties does not bound hidden/symbol reference retention | Enabled diagnostics add traversal/container-copy work; exotic custom serializers are explicitly omitted |
| Estimate retained strings by UTF-16 size and account encoded output separately | Worst-case JSON escaping estimates unnecessarily rejected the existing ordinary large-body fixture | Serializer/codec scratch remains outside the retained-payload bound; 16 MiB is not a total heap promise |

These decisions preserve inference and existing compatibility completion. They do not establish a production speed/memory win. No new SQL migration is introduced, but that alone is not proof of mixed-version data compatibility.

## Evidence chronology

The copied task reports and reviews preserve implementation-time findings, intermediate failures and subsequent approvals. Their historical “ready for review” or “blocked” statuses do not supersede this closeout record or the final qualification. Unless linked here, referenced probe scripts, raw logs, diffs and hash manifests remain in `.worktrees/cfw-resource-rollback-fix/.superpowers/sdd/2026-09-30-subsystem-contract-refactors/` relative to the main checkout; paths beginning `.superpowers/` in those reports are relative to the isolated checkout. They are not files in this documentation directory.

## Qualification scope

Final source candidate `9e54b9a2` is integrated into local `vNext`. Full `ci:local` passed with **5607 pass / 1 existing skip / 0 fail**, plus purity, all workspace typechecks, lint (0 errors / 34 warnings), UI build and Worker dry-run. Independent combined-contract review and the scoped exceptional-exit re-review are approved. See [qualification and integration](qualification.md), [initial final review](whole-branch-review.md), [lifecycle correction](final-fix-report.md) and [approved re-review](final-fix-review.md). No new CFW deployment, remote write, Docker replacement, dependency install or production measurement is part of this batch. The original main checkout overlay is preserved separately from scoped commits. Of its 37 protected files, 35 are byte-identical; the two reviewed adaptations exactly preserve the original overlay plus the scoped compatibility changes. A new companion overlay test remains untracked with its shim. All 1551 qualified source/config/test file hashes match the integrated checkout.

A complete CPU/heap/performance comparison remains an exact-artifact release gate. Structural budgets and reduced query result volume establish mechanisms, not an overall speed or memory improvement percentage. Workerd dry-run establishes bundling compatibility, not runtime resource capacity.

The quota fixture contains 120 hour/model buckets. The previous detail query returns 360 dimension rows and 120 request rows; the ordinary projection returns one row in one SQL statement. Request-only quotas skip dimensions and pricing; token-only quotas skip request totals and price lookup. Request denial takes priority before any numeric recheck. D1 scan work and the rare full-detail compatibility fallback remain outside this result-volume guarantee.

## Next priorities

1. Complete metadata/publication concurrency admission with an explicit visible saturation outcome. Keep inference status and existing diagnostic failure semantics deliberate; do not silently drop queued records or infer a whole-heap bound from payload estimates.
2. Measure the exact integrated artifact under local workerd against the retained deployment baseline: CPU/request, latency and heap/peak retention across ordinary requests, diagnostics on/off, large bodies and concurrency. Include the added diagnostic projection traversal and exceptional-guard callback allocation. No additional benchmark or production deployment was performed in this batch.
3. Qualify catalog/affinity mixed-version reads, writes and rollback against backups, then update the recovery runbook. No schema migration in this batch is not evidence of safe data rollback.

## Remaining projects

Item-reference history migration, accounting idempotency/outbox, strict quota reservations, an intentional HTTP/WS auth-policy change, physical storage isolation and broad dashboard query migration remain separate decisions. They need their own data/rollback model or total-workload evidence and are not smuggled into these refactors.
