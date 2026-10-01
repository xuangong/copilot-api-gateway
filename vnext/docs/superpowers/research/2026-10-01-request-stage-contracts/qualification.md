# Request stage qualification

Date: 2026-10-01. Product baseline: `8451196284a6c5f501f8b7e00a376bbd3009848f`. Qualified source commit: `717cd86e3a64af063c3f59c1a721c3aa31cf5b35`, with the separately preserved collaboration overlay. Documentation-only closeout changes do not alter this source candidate.

## Final local CI

From `.worktrees/cfw-resource-rollback-fix/vnext`:

```sh
SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local
```

Exit code: **0**.

| Gate | Result |
| --- | --- |
| Framework purity | OK |
| All workspace typechecks | Passed |
| Bun tests | 5616 pass / 1 existing skip / 0 fail; 236023 assertions across 535 files |
| ESLint | 0 errors / 34 existing warnings; existing multiple-project advisory |
| Setup and dashboard build | Passed |
| Cloudflare Worker dry-run | Passed; bundle 5192.66 KiB, gzip 1212.98 KiB |

The skipped test is the existing runtime X25519 derive-failure case. Dry-run proves bundling compatibility; it does not run a production Worker or measure resource capacity. No dependency installation, push, deployment, Docker replacement or service restart ran.

## Artifact identity and preservation

Before CI, `qualification-source.json` recorded SHA-256 for **1551** non-documentation source/config/test files, including the active overlay. After CI all 1551 still match. All **14** isolated protected overlay files and **38** main-checkout protected files remain byte-identical to their pre-task manifests.

These results qualify the current source plus the preserved overlay, not a clean checkout of committed source alone. Overlay qualification/commit disposition remains a release concern; this task does not silently include those files in its commits.

## Review and retention evidence

Design review approved the reference-adoption direction. Initial implementation review found one Important/P2 listener retention defect, fixed in `717cd86e`. [Scoped re-review](task-1-rereview.md) approved the fix with independent Node/Bun reachability checks and 9 cancellation tests (29 assertions). The implementation's post-fix kit/turn-barrier/SQLite ownership run passed 79 tests (289 assertions). [Final combined review](whole-branch-review.md) approved specification compliance and architecture/code quality with no outstanding findings, including an independent recheck of all source and preservation manifests.

| Runtime | Historical base: payload alive after serve | Fixed source: payload alive after serve | Fixed source: alive after abort |
| --- | --- | --- | --- |
| Node v26.0.0 / V8 | false | false | false |
| Bun 1.3.0 | true | false | false |

The original uncorrected source retained the payload in both runtimes. The no-signal control released it in both. This isolates a local reachability path while preserving post-attempt streaming cancellation. It is not a workerd measurement, retained-byte estimate or whole-service performance claim.

The retained documentation probe was also executed successfully from its final path, reproducing the fixed-source boolean results above. Its scoped ESLint run passed after the documentation copy was added; this evidence helper is not part of the runtime source candidate.

## Integration

Local `vNext` was fast-forwarded from `84511962` to qualified source `717cd86e`; closeout documentation follows that source without further runtime changes. Post-integration verification confirms **1551/1551** qualified files match, **38/38** original main-checkout protected files are unchanged, and **14/14** isolated protected files are unchanged. The existing fixture remains PID 90455 with the same start time, Wed Sep 30 05:16:07 2026 (`bun`). No service restart occurred. The reused worktree and its raw evidence remain preserved.

`source-integration-result.json` and `qualification-result.json` in the raw evidence directory record the observed source integration, counts and CI outcome. No push or deployment occurred. CFW resource and mixed-version rollback gates remain open as listed in the implementation record.
