# CFW P0 resource and rollback fixes

User-approved scope: fix the measured resource regression and old/new catalog/affinity rollback incompatibility. This implements the P0 actions in the September 30 measurement report. No production rollout, destructive restore, or credential rotation. Main-tree user changes and original frozen benchmark artifacts must remain unchanged.

## Current checkpoint

- [x] Implement and independently review the resource repairs through `12a7a762`, preserving the original collaboration overlay.
- [x] Run exact frozen full CI: 5,240 passed, 2 skipped, 0 failed; other CI stages passed. Same-lock dependency reuse remains a clean-install gap.
- [x] Complete the declared ordinary 4,000-request comparison: all semantic/transport and exactly-once checks pass. Resource acceptance fails CPU p50 in 2/5 pairs, memory p99 in 4/5, and client p95 in 3/10 cells. CPU p95 improves in all five pairs without overriding those failures.
- [x] Repeat large-body and altered-history checks: 80/80 ascending and 20/20 reversed-order successes; all dispatches exactly once, twenty success-only sampled windows, unchanged delayed-refresh hashes.
- [x] Record all favorable and adverse results, source/runtime boundaries and current architecture ruling in the [resource evidence](../research/2026-09-30-cfw-resource-remediation/README.md).
- [ ] Identify and reduce remaining ordinary allocation/background holding costs with controlled capture and frame/read diagnostics. Task 1 remains open.
- [ ] Pass joint enabled-feature resource qualification, remaining fault/cancellation/protocol coverage and one-hour mixed soak.
- [ ] Complete catalog legacy-writer and affinity rollback compatibility (Tasks 2 and 3).
- [ ] Complete combined qualification and integrate reviewed passing work into vNext (Task 4). No production deployment or push in this phase.

## Acceptance

- Joint CFW resource acceptance must balance response time, CPU and memory under unchanged feature/retention settings. Shorter background wall time cannot cancel CPU or memory regression. Keep the original paired gates and distinguish sampled shared-isolate memory from a per-request upper bound.
- Explain observed CPU/large-body failures with controlled diagnostics, not clone-count speculation. Eliminate avoidable ordinary request allocation while preserving request isolation, retry behavior, opaque ownership and egress stamping. Repeat remote original and altered-history workloads plus ordinary paired measurements; record failures and dropped arrivals.
- Legacy state writes cannot expose a previous account's catalog, and stale refresh work cannot publish across a credential identity change. Normal same-identity refreshes must not invalidate continuously. Use a new numbered migration; never alter historical migrations.
- Never claim immutable deployed baseline can recognize a new wire format. Provide and test an exact baseline compatibility rollback artifact if required. Prefer seamless continuation only with authenticated target proof; otherwise explicitly reject before dispatch with actionable fresh-session guidance, preserving the caller's original state. Do not decode/strip without authority or replay tools.
- Freeze and record hashes at launch for all new runs. Exact candidate must pass focused regressions, full CI, remote non-regression and recovery acceptance. Report any remaining release gates honestly.

## Task 1: Diagnose and reduce ordinary affinity allocation

Work in the repair worktree only. Read the existing memory triage and trace parse/affinity/translation/provider/output paths. Add discriminating local workload/stage evidence and failing regression tests before changing product behavior. Ordinary requests must retain egress identity/stamping. Owned markers must authenticate eagerly and fail closed. Retries and mutating provider interceptors must not share mutable request graphs. Avoid retaining duplicate canonical snapshots; use the existing semantics as the boundary, not an arbitrary request-size rejection. Record exact hypothesis, measurements, source changes, red/green tests and remaining remote proof. Commit only your task changes, never preserved collaboration overlay files. Cloud diagnostics are coordinated by root.

Architecture follow-up for Task 1: preserve the canonical turn, authority checks, retry isolation and stage/write/publish storage protocol. Optimize the internal ownership transitions before adding more caching or services. Measure foreground delivery separately from full background completion and isolate JS-heap versus external-buffer allocation. See the resource-remediation architecture review for current evidence and priorities. Dump content and storage formats remain unchanged by these performance repairs.

## Task 2: Guard catalogs against legacy credential-state writes

Trace legacy saveState and save/import SQL versus new replaceCredentials. Reproduce with real SQLite and legacy repository components, publish account A catalog, replace with B using old code, assert immediate invalidation and stale publisher rejection. Add a new migration and shared identity logic only as needed. Exercise Codex/Claude accounts, same-account refresh/quota updates, malformed/empty state, admin/owner access and newer replacement path. Avoid routine state refresh generation storms. Validate migration on isolated D1 and full old/new cycle. Commit only task files.

## Task 3: Make the rollback affinity boundary safe

Trace all accepted carrier fields and native HTTP/WS ingress. Determine the minimal compatibility rollback build from the exact deployed snapshot. Valid owned state may continue only with complete owner/key/target validation; otherwise return a defined restart-required error before provider dispatch. Keep raw foreign opaque values and ordinary requests unchanged. Test valid, corrupt, nested and cross-protocol markers plus tool-result/continuation inputs, direct routes and WS boundaries. Preserve original immutable tag; create a separately identified artifact and document the supported rollback target. No production deployment.

## Task 4: Requalify and integrate

Review each implementation, run exact combined-candidate CI, repeat remote controlled A/B measurements and migrated-DB code-switch acceptance. Archive private logs and sanitized metrics with hashes. Update measurement report, recovery runbook and original checklist. User authorized merging completed changes to vNext; integrate only reviewed passing fixes, preserving original dirty overlay and PRODUCT.md. Production remains unchanged.
