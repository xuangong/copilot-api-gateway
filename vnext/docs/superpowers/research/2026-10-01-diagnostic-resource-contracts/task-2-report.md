Archived from the preserved isolated-worktree evidence directory `.superpowers/sdd/2026-10-01-diagnostic-resource-contracts/`. Relative raw-log paths in this report refer to that directory.

# Task 2 implementation report

Status: complete, committed, ready for independent review.

- Base: `2f0a23e01103f70c1c41ee8a5c3e8a7eaa5d6670`.
- Commit: `2f09a995b9192afb40e1ad1c646d20fd4d8d4a7c`.
- Commit subject: `fix(vnext): release inactive diagnostic channels`.
- Worktree: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`.
- Scope: Task 2 only. No capture accounting, search admission, capacity policy, production, deployment, dependency or service changes.

## Committed files

1. `vnext/packages/gateway/src/shared/runtime/event-target-channel-broker.ts`
2. `vnext/packages/gateway/src/shared/runtime/channel-broker-contract.ts`
3. `vnext/packages/gateway/tests/event-target-channel-broker.test.ts`
4. `vnext/packages/gateway/tests/dump-terminal-handoff.test.ts`

The index was checked against exactly these four paths before commit. Root-owned documentation and the original protected overlay were not staged. The complete scoped patch is in `task-2-evidence/scoped.patch`; the stage inventory is in `task-2-evidence/staged-files.json`.

## Resulting contract and implementation

The private channel registry holds subscription-owned entries with an `EventTarget` and active-subscription count. Eager subscription acquires one reference, registers before the first pull, and exposes one shared iterator state. Pre-aborted subscription acquires nothing, registers no abort listener, and remains done. Each termination releases its reference once; the last release only removes the identical entry currently mapped to its channel ID.

Publication looks up an existing channel first. With no recipients it resolves before codec encoding, target creation or frame-event allocation. This intentionally removes notification validation from unsubscribed publication; persisted diagnostics still use existing storage/list reconciliation. With active recipients, the existing codec and eager fanout remain in use.

Channel close removes the old registry entry before close dispatch, preventing close-cleanup reentrancy from deleting a recreated channel. It immediately detaches frame/close listeners and releases ownership, preserves FIFO buffered frames, and retains the abort listener only while residual frames remain. The final buffered pull detaches that exact listener. Abort after close can still discard the buffer before another pull.

Abort, iterator return and iterator throw use the common termination path, discard buffered frames, detach abort observation, settle the one pending read with done and release ownership once. Return works before the first pull, after close and repeatedly. Throw performs cancellation and then rejects with the supplied error. A second pending next rejects explicitly without displacing the first read. Repeated retrieval returns the same iterator.

A post-decode closed-state check prevents a codec that synchronously cancels its subscription from enqueueing a frame after termination.

## TDD evidence

Commands below ran from `F/vnext`, where `F` is the worktree above. All RED output is retained.

| Phase | Command | Exit | Observed result | Log under `task-2-evidence/` |
| --- | --- | --- | --- | --- |
| Initial broker RED, before product changes | `bun test packages/gateway/tests/event-target-channel-broker.test.ts` | 1 | 8 pass, 14 fail, 22 tests. Failures cover unsubscribed encoding, pre-abort, canceled replay, pending-read settlement, shared iterator, concurrent next, last release, residual abort lifetime and close reentrancy. | `broker-red.log` |
| Storage integration RED, before product changes | `bun test packages/gateway/tests/dump-terminal-handoff.test.ts -t 'optional notification encoding'` | 1 | 1 pass, 1 fail, 15 filtered. Unsubscribed encoding count was 1 instead of 0; active encoding already followed committed storage. | `handoff-red.log` |
| Self-review reentrancy RED | `bun test packages/gateway/tests/event-target-channel-broker.test.ts` | 1 | 22 pass, 1 fail, 23 tests. Decode-triggered abort incorrectly allowed the canceled frame to be consumed. | `broker-reentrant-red.log` |
| Final broker GREEN | `bun test packages/gateway/tests/event-target-channel-broker.test.ts` | 0 | 23 pass, 0 fail, 58 assertions. | `broker-green.log` |
| Final focused GREEN | `bun test packages/gateway/tests/event-target-channel-broker.test.ts packages/gateway/tests/control-plane-dump.test.ts packages/gateway/tests/dump-terminal-handoff.test.ts packages/gateway/tests/dump-accumulator.test.ts` | 0 | 102 pass, 0 fail, 536 assertions across 4 files. | `focused-tests.log` |
| Final gateway typecheck | `bun run --filter '@vibe-llm/gateway' typecheck` | 0 | Gateway TypeScript check passed. | `gateway-typecheck.log` |
| Final framework purity | `bun run scripts/check-framework-purity.ts` | 0 | `[framework-purity] OK`. | `purity.log` |
| Final scoped lint | `bun run eslint packages/gateway/src/shared/runtime/event-target-channel-broker.ts packages/gateway/src/shared/runtime/channel-broker-contract.ts packages/gateway/tests/event-target-channel-broker.test.ts packages/gateway/tests/dump-terminal-handoff.test.ts` | 0 | No lint errors; resolver emitted its multiple-projects performance advisory. | `scoped-lint.log` |

From `F`, `python3 .superpowers/sdd/2026-10-01-diagnostic-resource-contracts/verify-artifact.py protect` exited 0 and confirmed all 38 main and 14 isolated protected hashes. `git diff --check` and `git diff --cached --check` also exited 0. Logs: `protected.log`, `diff-check.log`, `staged-diff-check.log`.

## Self-review

- Reviewed acquisition/release pairing, repeated termination, multiple subscribers, pending-reader ownership, pre-abort, graceful-buffer cancellation and same-ID recreation.
- Added observable AbortSignal listener registration/removal and exact listener-identity assertions without exporting registry state or production counters.
- Added the decode-triggered cancellation RED/GREEN cycle and post-decode guard described above.
- Moved SQLite storage-order assertions out of the codec callback. The callback captures the committed record/owned-file state, and the test asserts that snapshot after finalization so publication's best-effort error handling cannot swallow a test assertion.
- The storage tests cover both subscriber states: no encode with no recipients, and committed diagnostic record plus owned uploads visible before active-recipient encoding.
- Public method signatures, eager normal delivery and codec wire payloads remain intact. No new non-null assertions, `any`, suppression directives, exported registry or production test counters were added.
- No remaining Task 2 blocker or unresolved self-review finding.

## Limits and handoff

The change releases inactive channel and subscription lifetimes. It does not bound active slow-subscriber queues, buffered bytes/items or diagnostic publication task count; it adds no queue default, drop policy, replay log, retry, schema or environment setting. Cross-isolate delivery and history reconciliation behavior are unchanged. Source mechanisms and test outcomes are verified; no CPU, memory or latency gain was measured, and no benchmark was run.

No full CI was run. Root owns independent review, combined qualification and the final frozen-source full CI. Existing services and the Bun fixture were left running.
