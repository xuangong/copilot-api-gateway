## Finding verdicts

- **I1 — Canceling during terminal OAuth recovery still commits terminal state: ADDRESSED.** `vnext/packages/provider-codex/src/access-token.ts:113-129` now races the entire signaled operation, including its initial read, against cancellation and checks before returning a lease. The terminal-recovery branch checks after the authoritative read and passes the owned signal into persistence (`access-token.ts:170-191`). `vnext/packages/provider-codex/src/credential-effects.ts:90-101` checks before submission, inside the replayable real-repository updater, and after completion. A request canceled at the previously reproduced read barrier therefore settles with `AbortError`; its late continuation cannot publish `refresh_failed`. Final winner selection is also guarded at `access-token.ts:202-213`.
- **I2 — `.tokens` and flat envelopes bypass explicit provider/auth-type filtering: ADDRESSED.** `vnext/packages/provider-codex/src/auth/import.ts:86-100` defines one explicit tag predicate and applies it to source ancestors, the row, and the credential record. The `.tokens` and flat branches now use that predicate at `auth/import.ts:130-136`; multi-account branches preserve original indexes while carrying root/data tag constraints at `auth/import.ts:108-111,133-134`. The two previously accepted foreign-provider shapes no longer pass the supported-source gate.

## New breakage in the fix diff

None identified. The optional signal parameter preserves unsignaled callers, and terminal updates continue to pass through the existing credential-effect and repository fences. The tag fix preserves ambiguous-envelope rejection and the selected-source indexing contract.

## Checks and evidence

- Reviewed the complete 20,697-character `task-C08-parser-lifecycle-fix1.patch`, the appended Fix1 section of `task-C08-parser-lifecycle-report.md`, and the prior findings against the existing parser/lifecycle brief. The fix base is the initial frozen uncommitted candidate; repository HEAD remains `585d6f261b23c52927e90ebe08154d61d5fea883` as supplied by root.
- `vnext/packages/gateway/tests/codex-credential-effects.sqlite.test.ts:383-405` adds the exact terminal-recovery read/cancel scenario and asserts prompt `AbortError` plus retained active health. Lines 407-429 separately pause real `saveState` before updater preparation, then verify that cancellation prevents persistence; lines 431-449 cover cancellation during the final success-winner read.
- `vnext/packages/provider-codex/src/__tests__/auth/import.test.ts:147-160` adds nine negative tag cases covering all accepted envelopes and nested tag positions, with both empty preview and rejected import assertions. Lines 163-170 verify that a valid sibling retains source index 1 and remains importable.
- The appended report identifies the covering command, reports the pre-fix failures (three SQLite barriers and seven parser cases), and reports **213 pass / 0 fail** after the fix, plus package typechecks and warning-free targeted lint for fix1 files. Those results are implementation-provided evidence; this review did not rerun that suite or the original probes.
- No concrete remaining doubt required a new focused execution. No product edits, Git operations, unrelated code exploration, subagents, commits, pushes, deployments, or live-provider calls were performed. Root owns fresh full CI and the expanded actual workerd/D1 acceptance; their final results are outside this scoped verdict.

## Out-of-scope observations

- Initial M1 (the two `provider.ts` safe-error lint warnings) and M2 (invalid preview rows discarding otherwise known expiry/status) remain unchanged and explicitly ledger-deferred by root. They do not extend this fix round.
- No additional out-of-scope findings were added.

## Verdict

**Fix round: All findings addressed, no new Critical/Important breakage.** I1 and I2 are closed for this scoped review. Final clean-CI/workerd/D1 integration acceptance remains root-owned; F4 routes/UI remain a separate package.
