# Final minor-finding fix report

Status: DONE. Source/index ownership released to root after this report.
Base: `522df8ae1e012dfdf0484c3d381669a494573b08`.
Commit: `3ad2d0f12bf4fa8b5c59b24eb580cfa93a008ee7` — `fix(vnext/dashboard): preserve omitted request state`.

## Exact committed inventory

- vnext/apps/dashboard/src/tabs/requests/RequestsPanel.tsx
- vnext/apps/dashboard/src/tabs/requests/RequestsPanel.test.tsx
- vnext/packages/gateway/tests/data-plane/tools/web-search/retained-capacity.test.ts

Only these three files were staged and committed (59 insertions, 2 deletions). No root documentation or protected overlays were staged. Estimator/map production source is unchanged.

## Changes and review evidence

The actual panel now renders its empty message through a small RequestsEmptyState presentation component, requiring omittedRows === 0 alongside the existing loading/error/record-count gates. All-omitted snapshots retain the existing omission warning and older-page affordance without a contradictory no-retained-records assertion. The server-rendered regression covers omission, actual empty state, existing records, loading and list error.

Retained estimator supplemental regressions pin accepted depth 64/rejected 65 and accepted 65,536 visited values/rejected 65,537, with and without the optional retained key. Array root and its own length data property each consume a visit. Byte allowances are ample so traversal gates determine rejection. Reentry cases prove a nested insertion fills count capacity before the outer candidate is committed, and nested same-key replacement is refunded using its current charge; subsequent exact-total admission and excess rejection verify the stored counter. No estimator defect was found or manufactured.

## Validation and raw logs

All Bun commands below ran from F/vnext, using existing dependencies.

UI RED (after extracting the unchanged old predicate into the presentation component):

`bun test ./apps/dashboard/src/tabs/requests/RequestsPanel.test.tsx`

`final-fix-ui-red.log`: exit 1, 1 pass / 1 fail. The omittedRows=2 assertion expected empty markup but received dash.requests.empty. This is actual old-predicate behavior, not a missing-export failure.

Final focused GREEN:

`bun test packages/gateway/tests/data-plane/tools/web-search/retained-capacity.test.ts apps/dashboard/src/tabs/requests/RequestsPanel.test.tsx apps/dashboard/src/state/dumps.test.ts apps/dashboard/src/state/dump-live-session.test.ts`

`final-fix-focused.log`: exit 0, 16 pass / 0 fail, 75 assertions across four files. Supplemental capacity cases are hardening tests, not claimed RED evidence. During construction, an incorrect string length in the exact-byte reentry fixture (67 instead of 51) was corrected; capacity source remained unchanged. An initial root-relative file-write attempt while cwd was vnext changed no files; it is not RED evidence.

- `bun run --filter '@vibe-llm/gateway' typecheck`: exit 0, `final-fix-gateway-types.log`.
- `bun run --filter '@vibe-llm/dashboard' typecheck`: exit 0, `final-fix-dashboard-types.log`.
- `bun run scripts/check-framework-purity.ts`: exit 0, [framework-purity] OK, `final-fix-purity.log`.
- `bun x --no-install eslint apps/dashboard/src/tabs/requests/RequestsPanel.tsx apps/dashboard/src/tabs/requests/RequestsPanel.test.tsx packages/gateway/tests/data-plane/tools/web-search/retained-capacity.test.ts`: exit 0, `final-fix-lint.log`. Only inherited multiple-project resolver advisory, no lint findings.
- `git diff --check` and `git diff --cached --check`: clean.
- From F, `python3 .superpowers/sdd/2026-10-01-resource-capacity-policy/verify-artifact.py protect`: before and after commit, MAIN 38 / F 14 unchanged; `final-fix-protection.log` retains precommit result.
- Exact staged inventory verified before commit; postcommit index empty. Fixture readback: PID 90455, Wed Sep 30 05:16:07 2026, bun, unchanged.

## Remaining concerns and exclusions

No new source concern found. Whole-review deferred measurement, compatibility, history and publication gates remain unchanged. Full CI and final scoped re-review belong to root after this handoff. No full CI, network, production access, dependency install, service restart, push, deploy, cleanup, new worktree or subagent operation occurred. No new dependency, policy, migration, environment variable, any, suppression or non-null assertion was introduced.
