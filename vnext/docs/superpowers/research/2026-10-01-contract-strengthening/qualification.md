# Local contract qualification and integration

Date: 2026-10-01. This record covers the preparation, producer and hosted-tool private-state contract batch, including review corrections.

## Exact candidate

- Baseline: `dbde0567b505267098258fa3293b38ca29d3b27a`.
- Design/plan: `aaa6494257b2f6b3778562a969d45405e726b653`.
- Exact preparation and synchronous observation: `a3eb50537f37928d6729f4ca6e560f9858a948fc`.
- Translated producer alignment: `57a8ec926c29303421e7259e981f69093f55741d`.
- Owned private state and lazy lifetime: `1650ffc41df0f4c49c127d27cfebc896e03b65f8`.
- Sparse foreign-array correction: `291b078215abce54d4e50b6ee397f62833ada279`.
- Callback release and reentrant closure correction; final source head: `da6cc3693ff1a64ecb5d9670905f0f713d90d099`.

The qualified workspace is `.worktrees/cfw-resource-rollback-fix`, including its separately preserved 14-file collaboration overlay. The commit alone is not the complete tested artifact. Before CI, the controller froze **1,555** tracked and nonignored untracked `vnext` source/config/test files, excluding `vnext/docs/` and Markdown. Installed dependencies and ignored generated assets are outside this source manifest.

Manifest SHA-256: `a0d21a57d47b630870e8bf88c76bb04a72c44efe3070f46620562172b425189e`.

Raw evidence is retained in `.superpowers/sdd/2026-10-01-contract-strengthening/` in the isolated checkout: `qualified-source-manifest.json`, `qualified-source-metadata.json`, `qualification-result.json`, `ci-local.log`, task logs and correction diffs. It is not included in a clean clone of this documentation.

## Verification

The controller ran the final full CI once from the isolated `vnext`, after all source corrections and independent reviews:

```sh
SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local \
  > ../.superpowers/sdd/2026-10-01-contract-strengthening/ci-local.log 2>&1
```

Session `17236` exited **0**.

| Gate | Result |
| --- | --- |
| Full Bun test suite | **5,677 pass, 1 skip, 0 fail**, 543 files; 108.29 seconds |
| Package typechecks | All 26 packages exited 0 |
| Framework purity | Passed |
| ESLint | 0 errors, 34 inherited warnings in 29 files |
| Setup and dashboard builds | Passed |
| Cloudflare Worker bundle dry-run | Passed; upload 5,203.10 KiB, gzip 1,215.71 KiB |
| Post-CI source hashes | All 1,555 qualified files match |
| Original protected files | All 38 main and 14 isolated files match |

The single skip remains the runtime-dependent X25519 derive-failure case. Comparing lint diagnostics by file, message and rule with the preceding baseline log found no added or removed warnings; line-number changes were excluded from that comparison. The existing multiple-tsconfig resolver advisory remains. Prior-batch test counts were not reused for this qualification.

All three tasks have independent specification and quality reviews: [Task 1](task-1-review.md), [Task 2](task-2-review.md), and [Task 3 with corrections](task-3-review.md). The [whole-branch review](whole-branch-review.md) is CLEAN at the final source head, with no unresolved product finding. It verified the interaction of the contracts and original completion owners, not merely the sum of focused passing suites.

Review found and resolved two defects before final CI: sparse foreign arrays accepted by the decoder, and a closed lifetime retaining its metadata callback. The latter correction also ensures reentrant closure shares the same cleanup Promise and cannot repeat synchronous disposal. Focused RED/GREEN evidence is preserved in the [Task 3 report](task-3-report.md). Callback-reference removal is a source-level result, not a measured heap reduction.

## Integration and preservation

Local `vNext` was fast-forwarded from `dbde0567` to qualified source head `da6cc369`. After integration, both main and isolated checkouts match all **1,555** qualified source hashes. All **38** original main files and **14** original isolated files still match their protection manifests. Closeout documentation is committed separately without changing qualified source.

The existing Bun fixture remains PID `90455`, started `Wed Sep 30 05:16:07 2026`; it was not restarted. The reused worktree and raw evidence remain available. No reset, stash, overlay commit or cleanup was used to complete integration. The final local closeout HEAD and post-documentation checks are recorded in the ignored `qualification-result.json` to avoid a self-referential documentation commit hash.

## Contract coverage and remaining work

The [contract matrix](contract-matrix.md) covers the earlier ready capability and all 21 request normalizers as well as this batch. For each boundary it records input, guaranteed output, mutation authority, owner, lifetime and failure behavior. Reference strengths adopted are explicit preparation, source-owned state, synchronous payload correction and narrow dependencies; no new workflow framework or completion owner was added.

The source contracts now require explicit preparation with exact successful extra data, synchronous readonly observation, a translated producer domain matching runtime support, and typed reader/writer/disposer capabilities. Default private state belongs to the complete lazy hosted response; closure revokes access, settles existing metadata and retains incomplete-cleanup facts. Borrowed external stores remain externally owned, and malformed replay values fall back to the established missing-history output.

Remaining work is recorded separately from this completed batch:

1. Define count/byte admission and overflow behavior for active private state and diagnostic capture, then measure the exact candidate under local workerd for CPU, memory and latency. Owned lifetime can retain a long-running request's values longer than the previous TTL; no lower active peak is promised.
2. Qualify catalog/affinity upgrade and mixed-version rollback, including the backup/restore procedure, before any CFW deployment decision.
3. Reconcile the preserved collaboration overlay into an explicit release artifact. Current local CI includes that overlay and does not qualify a clean checkout of the commit alone.
4. Continue contract work in bounded increments: honest raw-object versus routing-ready ingress types/minimal model validation, call-local translation ownership, and typed settlement projections. Preserve native JSON, current tool-loop reentry and existing continuation/completion authority.

The legacy borrowed store retains its `void` interface and trusted synchronous convention. Readonly views are not deep immutability. An iterable abandoned without drain/return/throw/abort/discard supplies no deterministic cleanup signal. These limits do not invalidate the verified signaled lifecycle paths.

No push, deployment, existing-service restart, dependency installation, production access or benchmark was performed. Workers dry-run verifies local bundling; it does not establish production effectiveness or release readiness.
