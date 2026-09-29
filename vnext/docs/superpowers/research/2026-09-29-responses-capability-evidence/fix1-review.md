# C12 capability publication fix 1 review

## Spec Compliance

- **Spec compliant for the scoped fix delta.** R1, R2, and R3 are addressed. No new blocking defect was found in the four-file fix delta; the original full-task review remains retained in `task-C12-capability-review.md`.
- **Cannot verify from this diff:** final post-fix full CI, browser observation, and native Bun/workerd acceptance remain root-owned gates. The updated report explicitly separates pre-fix runtime evidence from pending post-fix acceptance. Root reports that all 22 frozen hashes match; this reviewer did not independently repeat that hash check.

## Strengths and Resolved Findings

- **R1 resolved.** `vnext/packages/gateway/tests/control-plane/capabilities.test.ts:24` creates a unique temporary file-backed SQLite database, constructs the real `BunSqliteRepo`, and persists real owner, API-key, and session rows at lines 29-33. The fabricated `Repo` and substituted database methods are removed. The test now checks real session authentication and anonymous rejection, restores fetch, closes the database, and removes the temporary directory (`:38`, `:61`).
- **R1 observation strengthened.** A real Copilot upstream row is seeded; the capability request is checked for zero outbound fetch calls and unchanged SQLite `total_changes()` (`vnext/packages/gateway/tests/control-plane/capabilities.test.ts:69`, `:79`, `:83`). Concurrent wrapped/unwrapped reads now place the barrier outside database operations while retaining independent scope assertions (`:87`, `:92`). As the writer notes, this barrier precedes `app.request`; it is not evidence of an in-handler hold. Root owns that additional runtime probe.
- **R2 resolved.** `vnext/apps/dashboard/src/tabs/keys/codex-capability.test.ts:35` uses an active signal and a throwing fetcher, asserts false, and proves fetch was called exactly once (`:42`). The independent pre-abort case asserts false and zero fetch calls (`:45`, `:53`). The previously unexecuted failure branch is now exercised by the test definition.
- **R3 resolved.** `vnext/packages/gateway/package.json:10` points the existing platform package path at a one-symbol re-export. `vnext/packages/gateway/src/shared/platform-ingress-capability.ts:1` exports only `withResponsesWebSocketIngress`; the internal capability reader is no longer exposed by that entry.

## Issues

### Critical

- None found in the fix delta.

### Important

- None found in the fix delta.

### Minor

- **R4 retained, nonblocking:** the updated writer report's verification section still records the multi-project ESLint configuration advisory separately from changed-file diagnostics. No new lint/product defect was established by this review.

## Focused Checks and Evidence Boundary

- Read the updated writer report and the complete fix1 delta once. Did not reopen or broaden the original candidate review.
- Named risk: the new database fixture could omit migrations. Checked `vnext/apps/platform-bun/src/bun-sqlite-repo.ts:58`: its constructor calls `initSqlite`; the initializer applies migrations at `:13`. The migration claim is consistent with the real adapter path.
- Named risk: new branded fixture values could weaken business-layer ID construction. Checked the type-only boundary in `vnext/packages/gateway/src/repo/branded-ids.ts:1`; the new casts are confined to synthetic fixture input, with real repository behavior retained. No new business-code branding bypass is introduced.
- No tests, CI, browser/runtime probes, or Git commands were run. No product, index, or branch changes were made. Only this scratch review report was written.

## Assessment

**Task quality: Approved for the scoped fix delta.** The blocking test-contract and missing-coverage findings are resolved, and the public export now matches the requested boundary. This approval does not replace root's final frozen acceptance gates.
