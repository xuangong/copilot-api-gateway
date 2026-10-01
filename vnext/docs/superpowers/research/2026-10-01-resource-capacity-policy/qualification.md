# Resource capacity policy qualification

Date: 2026-10-01. **Implementation, independent review, fresh complete CI and local vNext integration passed. No push or deployment occurred.**

## Exact artifact and verification

- Starting local vNext: `648a521eaa6c20a4ce937525e01c87093f46c8f4`.
- Last production-source/test change: `3ad2d0f12bf4fa8b5c59b24eb580cfa93a008ee7`.
- Frozen and first-integrated head: `4ee3c58c1b87713f18e5969cae36604a2421a842`. Subsequent closeout changes are documentation only.
- Frozen manifest: **1572 files**, SHA-256 `95c1ca609eff1d5777a1915a3ccc95b7a31d668ed0f5f97e14f1f8fc671a5ec4`. The artifact includes the 14 original isolated uncommitted protocol/collaboration files; the commit alone does not reproduce those bytes.
- Fresh `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` from `vnext/`: **5,880 pass, 1 skip, 0 fail**, 237312 assertions, 552 files, test phase 118.86s. Setup build, framework purity, all 26 package typechecks, lint, dashboard build and Workers dry-run passed. CI and its post-run source verifier both exited 0.
- Lint reports **0 errors / 34 warnings**, plus the existing multiple-project resolver advisory. The one skipped case is the runtime X25519 derive-failure case in `dialReality`; a skip is not a passing test.
- `git merge --ff-only fix/cfw-resource-rollback` moved local vNext from the starting head to the frozen head. Both trees then matched the entire frozen source manifest. Original MAIN 38 / isolated 14 dirty-file inventories and hashes remain intact; indexes are empty. Fixture remains PID 90455, start Wed Sep 30 05:16:07 2026, command `bun`.
- Full CI ran once after task and whole-increment reviews plus the one minor-finding fix wave. No duplicate complete CI was run after merging the identical verified source.

[Machine-readable qualification and first integration receipt](qualification.json) includes the raw CI log hash. Raw logs, full source manifest, protection manifests, ledger and final integration checks are retained in `.worktrees/cfw-resource-rollback-fix/.superpowers/sdd/2026-10-01-resource-capacity-policy/`. Existing dependencies were reused; this is not a clean-install or Docker-build qualification.

## Delivered contracts

| Stage | Enforced policy and behavior |
| --- | --- |
| Hosted work admission | 64 operations per Responses/Chat invocation before expansion/start, shared through reentry and refusal. |
| Successful provider ingress | 1 MiB per body, 8 MiB cumulative hosted ingress; immediate safe failure closes fallback/start gates while started work retains true settlement ownership. |
| Owned retained state | Private replay 64 entries / 4 MiB estimate; page cache 64 / 2 MiB; generated Chat continuation 4 MiB. Atomic admission, net replacement and bounded noncloning traversal. |
| Diagnostic live delivery | 100 frames / 256 KiB encoded charge, 16 KiB per frame; 4 route owners per key / 16 per isolate. Legacy streams cannot bypass queue/permit limits. |
| Latest-view recovery | Explicit overflow, bounded latest snapshot and SQL-page cursor, manual refresh with generation isolation, persistent continuity/omission status, truthful empty state. |

Individual task reviews and the [whole review](whole-review.md) found no remaining Critical/Important issue. Both selected minor findings were resolved and [scoped re-reviewed](final-fix-review.md). The final fixture tests exercise actual SQLite, Hono backpressure, provider settlement and live-session owner behavior in addition to helper boundaries.

## Decisions made during implementation

1. Extend the shared body-capacity error propagation to the native Messages shim. Its old catch would otherwise downgrade the new error to unavailable. **Cost:** this formerly recoverable-looking search failure now explicitly ends the response. Messages still has no new invocation-wide operation/aggregate ingress budget.
2. Add optional SQL-page `before` and `hasMore` to latest-v1, including their envelope charge, so all-omitted snapshots can still browse older records. An envelope that cannot fit emits the finite capacity terminal. **Cost:** the new server/client pagination contract must ship together; an incorrect SQL boundary could skip older rows. It remains a latest view and cannot certify complete recovery.

## Boundaries and next priorities

These are provisional accounting/admission policies, **not measured physical heap ceilings, CPU savings, latency improvements or CFW-safe production defaults**. Runtime chunks, JSON/normalization transients, initial/caller-owned history, current-turn assembly, external legacy stores, SQL result materialization and diagnostic publication are outside the corresponding charges. Borrowed retained graphs must not mutate after admission. Noncooperative SQL/writers can keep diagnostic permits occupied until they actually settle. Browser accumulated history, detail/export and decompression remain separately unbounded.

1. Repair/review the local workerd runner and perform a fresh completed comparison against deployed tag `vnext-deployed-20260928-233856` (`e660fb4d`), using durable offered/completed journals and strict completion gates. Keep ordinary timing and targeted search/diagnostic saturation separate. [Runner readiness](workerd-readiness.md) is preparation only. Local latency/sampled CPU/settled heap cannot establish cloud billed CPU or peak memory.
2. Implement and qualify legacy state-only catalog identity invalidation, plus a separately identified baseline affinity-compatible rollback artifact. The immutable deployed tag does not gain a new carrier reader. [Current source audit and bounded local matrix](rollback-readiness.md) describe the remaining gap; no fresh runtime compatibility claim is made.
3. Rehearse old/new code switches and coordinated backup/restore before release, preserving catalog revisions, affinity keys, database/object relationships and documented data-loss boundaries. No new backup, restore or production operation occurred in this increment.
4. Address publication admission/receipts, browser history windows and full-detail policies separately. The bounded feed and Refresh latest cannot prove complete historical or cross-isolate delivery.

All protected work, dependencies, worktree and raw evidence are retained. No production access, service restart, dependency installation, push or deployment was performed.
