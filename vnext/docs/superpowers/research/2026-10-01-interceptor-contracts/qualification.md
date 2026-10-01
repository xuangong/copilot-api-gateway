# Local qualification and integration

Date: 2026-10-01. This record covers the synchronous request-normalization contract batch only.

## Exact candidate

- Baseline: `c3a365511211f709a19207851317587f250740a7`.
- Design/plan: `840fdf2821ea0cb3a96f68e123caacfe8e9c48bf`.
- Service contract and gateway wrapper: `c1acacea816278d91ebcd9e4824a860857f61331`.
- Twenty-one leaf migrations and composition tests: `4b8afdad92fccff28ccc29614e0a7ad5fdc21c2c`.
- Qualified workspace: `.worktrees/cfw-resource-rollback-fix`, including the separately preserved collaboration overlay. The commit alone is not the complete tested artifact.
- Frozen manifest: 1,555 non-documentation files enumerated from tracked and nonignored untracked `vnext` files. It covers source, tests and configuration, including the 14 protected overlay files. Ignored generated build outputs and installed dependencies are not in this source manifest.
- Manifest SHA-256: `516062b070ea4cd03ff324fa368f2b0a3e16fc5c364a3719c5a6e75e5d65f864`.

Raw manifests, logs, task reports and the progress ledger remain in `.superpowers/sdd/2026-10-01-interceptor-contracts/` inside the isolated checkout. `qualified-source-manifest.json` contains individual hashes; `qualified-source-metadata.json` and `qualification-result.json` identify the candidate and result.

## Verification

The controller ran this command once from the isolated `vnext`:

```sh
SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local \
  > ../.superpowers/sdd/2026-10-01-interceptor-contracts/ci-local.log 2>&1
```

Session `62383` exited **0**:

| Gate | Result |
| --- | --- |
| Full Bun test suite | 5,631 pass, 1 skip, 0 fail across 537 files |
| Package typechecks | All 26 packages exited 0 |
| Framework purity | Passed |
| ESLint | 0 errors, 34 warnings in 29 files outside the batch diff |
| Setup and dashboard builds | Passed |
| Cloudflare Worker bundle dry-run | Passed; upload size 5,191.97 KiB, gzip 1,213.01 KiB |
| Frozen source after CI | All 1,555 hashes match |

The single skip is the existing runtime-dependent X25519 derive-failure case. The lint warnings are in unchanged files; the multiple-tsconfig resolver advisory also remains. These are recorded limitations of the existing gate, not newly introduced normalizer findings. The task-scoped changed-file lint runs have no lint findings.

Task 1 additionally has behavioral RED/GREEN evidence and type assertions excluding async/void callbacks. Task 2 has a pre-migration characterization run and a grouped affected run of 457 pass / 0 fail, including real registries, hosted loops, native/cross attempts, producer-domain checks, Responses turn barriers and dump ownership. See the [Task 1 report](task-1-report.md), [Task 1 review](task-1-review.md), [Task 2 report](task-2-report.md) and [Task 2 review](task-2-review.md).

## Integration and preservation

The [whole-branch review](whole-branch-review.md) approved local integration with no Critical or Important findings. The inherited resolver advisory is non-blocking. Its documentation clarification about Messages/Chat bypassing the native source registry was applied and reread by the reviewer.

Local `vNext` was fast-forwarded from `c3a36551` to source head `4b8afdad`. After integration, both the main and isolated checkout match all 1,555 qualified source hashes. All 38 original main-checkout files and all 14 original isolated overlay files still match their preservation manifests. The existing Bun fixture remains PID `90455`, started `Wed Sep 30 05:16:07 2026`; it was not restarted. The closeout documentation is committed separately without changing qualified source.

The reused worktree and raw evidence are retained because they hold protected uncommitted work. No reset, stash, cleanup or overlay commit was used to complete integration.

## Evidence limits and remaining gates

This batch makes request-only authority explicit and preserves existing payload transformations, registry placement and lifecycle ownership. Each module constructs its adapter once; successful execution returns the downstream promise directly. No new schema, environment variable, retry policy or lifecycle owner is added.

This is local correctness and build qualification. It does not measure whole-service CPU, latency or memory, and Worker dry-run is not a deployment or production test. No push, deployment, existing-service restart, dependency installation or benchmark was performed.

Before a release claim, reconcile the collaboration overlay into an explicit release artifact, measure that artifact under local workerd, qualify catalog/affinity mixed-version rollback, and complete diagnostic-publication admission. The next bounded architecture increment is [private payload lifetime and capacity](private-state-followup.md), followed by call-local translation ownership and typed settlement projection contracts.
