# Final source qualification and local integration

Date: 2026-10-01. Source candidate: `9e54b9a2e784be5c536130b5b3f60c26a8b2e1a9`, based on `57501ed3d8594227786f4ca130668f3ce600ff54`, plus the separately preserved collaboration overlay. This record is local acceptance of the implemented scope, not deployment approval or a measured production performance claim.

## Final verification

Ran in `.worktrees/cfw-resource-rollback-fix/vnext`:

```sh
SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local
```

The complete command exited **0** on the frozen source:

- Setup asset build, framework purity and all workspace typechecks passed.
- **5607 pass / 1 skip / 0 fail**, 235976 assertions; 5608 tests across 535 files.
- The installed native Codex configuration-parser acceptance test passed. The only skipped case is the existing runtime-specific X25519 off-curve/derive failure case.
- ESLint passed with **0 errors / 34 warnings**.
- UI build and Worker dry-run passed. Bundle report: 5191.66 KiB, gzip 1213.25 KiB. This is build evidence, not workerd runtime CPU or memory evidence.

All 1551 source/config/test file hashes were frozen before the command, matched after verification, and matched the resulting source commit. The final fix was committed while the command was running without changing those bytes. Documentation changes after qualification do not change the qualified product artifact.

The first integrated attempt exposed an obsolete `pinned.catalogs` test, corrected in `3a44ab10`. Its resumed checks passed before final review identified the exceptional reservation leak. Those earlier results were superseded by the full final command above, after `9e54b9a2` fixed that runtime defect. No result from an older artifact is used as final qualification.

## Independent review

[Whole-branch review](whole-branch-review.md) confirmed one P2: exceptional ordinary preparation bypassed terminal capture ownership and leaked its numeric budget reservation. [The scoped correction](final-fix-report.md) closes that exit and the demonstrated direct caller variants without changing request error semantics. [Independent re-review](final-fix-review.md) approved Spec and Quality, reproduced zero residual reservation, and passed 41 targeted tests / 160 assertions. There are no remaining material findings in the reviewed implementation scope.

Tasks 1–5 are complete. Task 6's retained-payload slice is accepted; publication/metadata concurrency remains explicitly open. Estimates do not cover whole-isolate heap, all ingress/materialization, tee queues, optional upstream-prefix ownership, or encoder/compression scratch. Performance and mixed-version recovery remain separate gates.

## Local integration and preservation

Fast-forwarded local `vNext` from `57501ed3` to `9e54b9a2`, then replayed the reviewed overlay adaptations. The final documentation-only closeout follows this source commit.

- All 37 original main-workspace protected files matched their preflight hashes before integration.
- After integration, 35 remain byte-identical. The Responses attempt and untracked collaboration shim include only their reviewed adaptations; their original bytes remain backed up.
- Independently applying the scoped committed base diff to the original Responses attempt produces the exact tested file. Applying the reviewed shim patch to the original shim likewise produces the exact tested shim.
- The new `producer-domain-collaboration.test.ts` remains untracked with its pre-existing shim. The tracked producer-domain test was separately verified in a clean archive without that shim: 4 pass / 25 assertions.
- All **1551** frozen source/config/test files match the integrated main checkout. Both indexes were empty after source integration.
- Fixture PID **90455**, start time **Wed Sep 30 05:16:07 2026**, remains the same `bun upstream.ts` process.
- No push, CFW deployment, Docker replacement, production write, service restart or dependency installation occurred. The working tree intentionally retains the pre-existing uncommitted overlay; it is not a clean release artifact.

## Evidence location and remaining gates

Raw evidence is retained under `.worktrees/cfw-resource-rollback-fix/.superpowers/sdd/2026-09-30-subsystem-contract-refactors/`: `ci-local-final.log`, `qualification-source.json`, `integration-result.json`, the final-fix hashes/diffs/logs, and the original overlay backups/composition proofs. The copied reports in this documentation directory are the portable narrative record.

Next: define visible publication-concurrency admission; perform an exact-artifact local workerd CPU/heap/latency comparison; verify catalog/affinity old/new data and rollback behavior against backups. Preserve the deployment baseline until those gates justify an update. Item-reference history, durable accounting outbox/idempotency, strict quotas, HTTP/WS auth-policy convergence, physical storage isolation and broad dashboard-query migration remain separately scoped projects.
