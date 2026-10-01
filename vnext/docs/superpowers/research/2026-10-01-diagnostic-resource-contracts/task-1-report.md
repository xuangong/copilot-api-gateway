Archived from the preserved isolated-worktree evidence directory `.superpowers/sdd/2026-10-01-diagnostic-resource-contracts/`. Relative raw-log paths in this report refer to that directory.

# Task 1 implementation report

- Status: implemented, focused verification passed, source/tests committed.
- Base: `2ce2d492c98b26acafc7f770a2d44baf3372dfd6`.
- Source commit: `0c53ce12397fb73d9c4d8b7925ac636418c4de8f` (`refactor(vnext): encapsulate dump capture retirement`).
- Scope: Task 1 only. No broker implementation, dependency installation, service activity, network access, benchmark, production access, push or deployment. No complete CI was run.

## Changed files

1. `vnext/packages/gateway/src/shared/dump/capture-budget.ts`
2. `vnext/packages/gateway/src/shared/dump/accumulator.ts`
3. `vnext/packages/gateway/src/shared/dump/__tests__/capture-contract.test.ts`
4. `vnext/packages/gateway/tests/dump-capture-budget.test.ts`

The existing SQLite suite already discriminates preparation, file upload and broker publication charges; exact omission metadata; rejected preparation; terminal failures; repeated completion; and storage-before-publication. It was run unchanged. The exception-ownership, terminal-handoff and accumulator suites likewise ran unchanged.

## Mechanism and self-review

- `DumpCaptureBudget.open()` now returns the exact `DumpCaptureScope` interface. Its `capture` getter returns the separate `DumpCapture` facade.
- Budget, facade and scope keep module-local accounting state behind ECMAScript private fields. The budget has no raw reserve/release methods, and the capture view has no release/retire methods. The exported reservation constructor and free retirement helper are removed.
- The first retirement receipt is memoized before observing the bound promises, including synchronous reentry through a promise's `then`. `Promise.allSettled` observes both phases immediately, retains their accounting until both settle, and releases once regardless of either rejection. Preparation rejection wins; otherwise the work outcome wins.
- Admission remains open during retirement and refuses every admission method after completion. Omission remains monotonic. Repeated retirement returns the original Promise and replacement inputs do not control ownership.
- The final reaction is constructed in a separate helper that captures only scalar accounting state and the void completion receipt. The scope stores only the void retirement result, never work/preparation promises or payload graphs. A rejected result preserves its required error reason.
- Accumulator changes only the capture/owner fields, initialization and its existing retirement helper. Work creation, scheduler registration, preparation receipts and persistence/publication ordering are unchanged.
- Capture constants and the complete `projectGraph` prefix were compared against BASE and are byte-for-byte unchanged. There is no new per-frame closure/wrapper allocation or redundant projection.
- Before committing, the index was checked against the exact four-file list and the protected isolated manifest; no protected files or root documentation were staged. The index was empty afterward.

## RED evidence

These initial raw outputs were preserved from the actual tool command results in `task-1-evidence/` before the new API was implemented:

| Command and cwd | Result | Evidence |
| --- | --- | --- |
| `bun run typecheck` in `vnext/packages/gateway` | Exit 2; three TS2344 assignability failures for public budget reserve/release and capture release. The assertions used the old `ReturnType<DumpCaptureBudget["open"]>` and did not depend on a missing export. | `task-1-evidence/red-typecheck.log` |
| `bun test packages/gateway/tests/dump-capture-budget.test.ts` in `vnext` | Exit 1; 5 pass, 1 fail; runtime budget raw reserve was present. | `task-1-evidence/red-budget-contract.log` |

Before source implementation, the migrated lifecycle tests were also run against the old API: exit 1, 0 pass/16 fail because the owner/capture split was absent. The earlier contract run is the meaningful assignability/runtime RED, while this second run confirms the new lifecycle tests preceded production implementation.

## GREEN evidence

All commands below ran in `vnext` using existing dependencies, and their outputs were captured directly to the following logs:

| Command | Result | Evidence |
| --- | --- | --- |
| `bun test packages/gateway/tests/dump-capture-budget.test.ts packages/gateway/tests/dump-capture-budget.sqlite.test.ts packages/gateway/tests/dump-exception-ownership.sqlite.test.ts packages/gateway/tests/dump-terminal-handoff.test.ts packages/gateway/tests/dump-accumulator.test.ts` | Exit 0; 110 pass, 0 fail, 795 assertions across 5 files. Budget tests account for 16 passing cases. | `task-1-evidence/focused-tests.log` |
| `bun run --filter '@vibe-llm/gateway' typecheck` | Exit 0. | `task-1-evidence/gateway-typecheck.log` |
| `bun run scripts/check-framework-purity.ts` | Exit 0; OK. | `task-1-evidence/framework-purity.log` |
| `bunx --no-install eslint packages/gateway/src/shared/dump/capture-budget.ts packages/gateway/src/shared/dump/accumulator.ts packages/gateway/src/shared/dump/__tests__/capture-contract.test.ts packages/gateway/tests/dump-capture-budget.test.ts` | Exit 0; no code diagnostics. Existing multi-project tsconfig advisory only. | `task-1-evidence/scoped-lint.log` |

From the isolated worktree root, `git diff --check` and `git diff --cached --check` passed. `python3 .superpowers/sdd/2026-10-01-diagnostic-resource-contracts/verify-artifact.py protect` passed before implementation, before commit and after commit: all 38 main and 14 isolated protected files match. The saved pre-commit output is `task-1-evidence/protect.log`.

## Concerns and remaining boundaries

- No task-specific unresolved correctness concern found in self-review.
- No CPU, heap, memory or latency gain is claimed; this is authority/lifecycle encapsulation with targeted behavioral evidence.
- Focused verification does not replace the root's independent reviews, frozen-source complete CI and integration qualification.
- Active-subscriber queue capacity and publication-count policy remain outside Task 1.

## Fix round 1 — review I1

- Review: `task-1-review.md`, Important I1. The original aggregate could reject while accessing/calling an input promise's throwing `then`, stop before observing the other input, leave the memoized receipt pending, and discard an unhandled rejection. This invalidated the initial self-review's no-unresolved-concern conclusion for that observation boundary.
- Fix base: `0c53ce12397fb73d9c4d8b7925ac636418c4de8f`.
- Fix commit: `2f0a23e01103f70c1c41ee8a5c3e8a7eaa5d6670` (`fix(vnext): isolate dump retirement phase observation`).
- Changed files: `vnext/packages/gateway/src/shared/dump/capture-budget.ts` and `vnext/packages/gateway/tests/dump-capture-budget.test.ts` only. Accumulator integration and all other production modules are unchanged by this round.
- Fix mechanism: immediately observe each phase inside its own native Promise executor. The executor turns a synchronous `then` getter/method error into only that phase's rejected outcome, so the next phase is still observed. The aggregate receives only these native receipts. The original retirement receipt remains memoized before any observation can reenter, and the existing both-phase release and preparation-rejection precedence remain unchanged.
- Retention review: each receipt's fulfillment callback is created in a separate helper capturing only its resolve function; it resolves with `undefined`, without forwarding a runtime payload result. The synchronous executor is not retained after construction. There is no new per-frame allocation; two small native phase receipts are added only when retirement is first selected.
- Regression matrix: both broken phases, throwing getters and throwing methods, and a deferred other phase that either fulfills or rejects. Assertions discriminate immediate observation of the other phase, retained charge/admission while pending, eventual retirement, preparation precedence, shared receipt identity and post-retirement refusal. Bun's successful run also emitted no unhandled error output.

| Command, all in `vnext` | Result | Evidence |
| --- | --- | --- |
| Before the fix: `bun test packages/gateway/tests/dump-capture-budget.test.ts` | Meaningful RED; exit 1, 16 pass/8 fail. Work observation failures show the other phase was not observed; throwing observation errors surface in the runner. All eight cases preceded source implementation. | `task-1-evidence/fix-1-red-budget.log` |
| After the fix: `bun test packages/gateway/tests/dump-capture-budget.test.ts` | Exit 0; 24 pass/0 fail, 271 assertions. Existing synchronous reentry and phase-order matrix remain passing. | `task-1-evidence/fix-1-green-budget.log` |
| `bun run --filter '@vibe-llm/gateway' typecheck` | Exit 0. | `task-1-evidence/fix-1-gateway-typecheck.log` |
| `bunx --no-install eslint packages/gateway/src/shared/dump/capture-budget.ts packages/gateway/src/shared/dump/accumulator.ts packages/gateway/src/shared/dump/__tests__/capture-contract.test.ts packages/gateway/tests/dump-capture-budget.test.ts` | Exit 0; no code diagnostics. M1's existing multi-tsconfig advisory remains explicitly deferred by the root. | `task-1-evidence/fix-1-scoped-lint.log` |

From the isolated worktree root, `git diff --check` and `git diff --cached --check` passed. The protected-manifest check passed for all 38 main and 14 isolated files (`task-1-evidence/fix-1-protect.log`), and the index was asserted to contain exactly the two fix files before commit. Root documentation and protected overlay were not staged. No complete CI, services, installations, network activity, broker work or subagents were used. The five unchanged integration suites were not rerun, per the fix-round scope; final independent re-review and qualification remain with the root.
