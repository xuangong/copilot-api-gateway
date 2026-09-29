# C12-F1 fix1 independent scoped review

## Scope and integrity

Reviewed only `task-C12-F1-fix1-review.diff` (five changed product/test files), against R1-R3 in `task-C12-F1-review.md`, plus Important regressions introduced by that fix diff. Read the root/vnext agent instructions, fix1 brief and implementation report's fix round 1. This is not a fresh review of the full F1 change.

Independently verified all **18/18** candidate file SHA-256 values against `task-C12-F1-fix1-frozen-sha256.json`, both before and after review; no mismatches. The reviewed diff's SHA-256 is `422ead54b418bc55c8a6995147f209244b086af448510d176650c2b267b5b86e`.

## Spec Compliance: PASS (scoped fix1)

- **R1 — ADDRESSED.** `vnext/packages/gateway/src/data-plane/chat-flow/responses/turn.ts:327` forwards `result.targetApi` for an upstream-error result into the fifth `recordPerformance` argument. The helper uses that override for both legacy performance rows and metrics, with the existing source-derived fallback only when the override is undefined. Existing Messages/Gemini translated-error assertions remain intact.
- **R2 — ADDRESSED.** `responses/turn.ts:202` provides the same terminal-to-body mapping used by HTTP JSON at `responses/respond.ts:23`. The canonical body is captured before terminal delivery (`turn.ts:426`) or from the emitted failure (`turn.ts:439`), and passed to turn-owned finalization (`turn.ts:333`). `shared/dump/accumulator.ts:192` serializes that body only when no frame log exists, retaining frame precedence. Three added tests at `tests/dump-accumulator.test.ts:407` inspect stored bytes against the actual rendered wire body, response status, sent-byte count and cleanup completion for legacy JSON success, sanitized snapshot failure and upstream error. No transport tee, new inference reader or delayed ownership registration was introduced.
- **R3 — ADDRESSED.** `tests/data-plane/chat-flow/refusal-failed-json.test.ts:12` collects background promises, then drains them before platform reset. The production turn still unconditionally registers completion at creation (`responses/turn.ts:462`); no silent production fallback was added.

Paths abbreviated above are under `vnext/packages/gateway/src/data-plane/chat-flow/` for `responses/*`, under `vnext/packages/gateway/src/` for `shared/*`, and under `vnext/packages/gateway/` for `tests/*`.

## Quality: PASS (scoped fix1)

No new Critical or Important issue was found in the five-file fix diff. The shared body mapping preserves the previous renderer behavior while supplying the missing dump fallback; optional-body handling keeps the existing no-body path, and cleanup still awaits the dump write. The fixture repair observes the production completion contract rather than weakening it.

Verification evidence was inspected directly, not accepted solely from the implementation report:

- `/tmp/c12-f1-fix1-dump-red.log`: the three new body tests failed on `none` versus `bytes` before the fix.
- `/tmp/c12-f1-fix1-existing-red.log`: the original refusal fixture failed on missing background initialization before the fix.
- `/tmp/c12-f1-fix1-final-tests.log`: **267 pass / 0 fail / 791 assertions / 23 files**, including all three no-frame tests, the refusal fixture, and translated upstream-error persistence coverage.
- `/tmp/c12-f1-fix1-final-typecheck.log`: all three scoped package checks exited 0; `/tmp/c12-f1-fix1-purity.log`: purity passed.

These are inspected writer-run logs, not a reviewer rerun. No test suite or runtime process was started by this reviewer, preserving root's solo full-CI/runtime execution.

## Narrow unchanged context inspected

- `shared/respond-telemetry.ts:260`: verified the new fifth argument is the actual hub override, and that both persistence branches consume it. This resolves the concrete risk of passing the target into the wrong optional parameter or fixing only one persistence path.
- `shared/dump/accumulator.ts:278`: verified no-frame bytes become a stored bytes body, and existing frame precedence is retained. This resolves the concrete risk of generating bytes that the downstream writer still discards.
- `tests/dump-accumulator.test.ts:76`: checked that the new regression cases use a real SQLite repo and FileDumpStore with the existing in-memory file provider, and initialize the required background executor.
- `shared/traverse-translation.test.ts:165`: checked the unchanged Messages/Gemini error assertions query persisted target protocols. No full F1 diff or unrelated implementation was reviewed.

## Acceptance boundary

R1-R3 are closed by this scoped code/evidence review. Overall F1 acceptance remains with root after its fresh solo full CI and frozen runtime checks, including the extended 22-group HTTP/SQLite/file probe. This report makes no F2/F3/F4 or deployment-readiness claim. No product, Git/index/configuration changes, subagents or live calls were made; only this review artifact was written.
