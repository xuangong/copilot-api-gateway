# Frozen-source qualification and local integration

Date: 2026-10-01. Status: complete for this local increment. No push or deployment.

## Exact artifact

- Baseline: `db9ce4f35abab6fbed34dc038d1efd2c979cf773`.
- Qualified source checkpoint: `0e44391d600add13daa665de820911198f1bd44f`. The final product repair is `482f1a23`; later closeout commits change documentation/evidence only.
- Frozen non-document source/config/test files: **1560**.
- SHA-256 of the retained source manifest: `2f3b7d969e2acdcf630cfdbf7a367669fa9c61c803218167a39f90dd4f6b7c3b`.
- The qualified working-tree artifact includes the original **14 isolated protected overlays**. These were not committed or staged. This result does not separately qualify a clean commit without those overlays.
- Manifest metadata: [qualified-source-metadata.json](qualified-source-metadata.json). Full per-file hashes and raw logs remain in the retained worktree's `.superpowers/sdd/2026-10-01-hosted-search-execution-contracts/`.

## Complete CI

Exactly one full run for this frozen candidate:

```sh
SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local
```

Run interval: `2026-10-01T11:45:51.604443+00:00` to `2026-10-01T11:48:17.516202+00:00`. Exit **0**.

| Gate | Observed result |
| --- | --- |
| Framework purity | Passed |
| Workspace typechecks | 26 packages passed |
| Bun tests | 5,780 pass, 1 existing skip, 0 fail; 236,880 assertions; 546 files |
| ESLint | Exit 0; 0 errors, 34 warnings plus the resolver advisory |
| Setup and dashboard builds | Passed |
| Cloudflare Worker dry-run | Passed; explicit dry-run exit, no deployment |

The skipped case is the unchanged `dialReality` runtime X25519 derive-failure test, explicitly marked `it.skip` in `packages/proxy/src/__tests__/protocols/reality_test.ts:138`. The changed-file lint warnings were reproduced on their baseline and triaged nonblocking in [whole review](final-review.md). Other warnings remain existing repository debt; this is not a warning-free lint claim.

CI metadata and summary: [final-ci-summary.json](final-ci-summary.json). Raw log SHA-256: `f696808a15b333e5f4026c567497e683221c1a5f6903ad594fb57ac28cedbb4c`. The frozen manifest was checked before CI, after CI, and on both checkouts after integration. No source/config/test input changed after freeze. The merged source was not redundantly retested because its full source manifest is identical to the qualified artifact.

## Review and preservation

All three task gates passed after Task 2's scoped fix. The whole-increment review found one additional inherited Responses final-delivery race; [its accepted scoped repair](final-fix-review.md) resolves the sole final blocker. Both Chat and Responses now check closure at the outer post-await delivery boundary. Same-tick discard/parent-abort regressions and normal open/drain controls verify those exact owners; they are not claimed as HTTP/production reproductions.

Local `vNext` was fast-forwarded from `db9ce4f35abab6fbed34dc038d1efd2c979cf773` to `0e44391d600add13daa665de820911198f1bd44f`. Both checkouts matched all 1,560 frozen files afterward. Original **38 main / 14 isolated** protected hashes and both original dirty inventories remained identical; both indexes stayed empty. Fixture PID **90455**, started **Wed Sep 30 05:16:07 2026**, remains the same Bun process. Initial integration readback: [integration-result.json](integration-result.json). The subsequent qualification closeout is documentation-only and receives the same manifest/protection/inventory/fixture checks.

The worktree, branch, dependencies, raw evidence and protected uncommitted work are retained. No production access, install, service restart or benchmark occurred.

## Architectural result and remaining gates

The implemented contract is explicit preparation, single start, owned delivery, synchronous cancellation and separately observed real settlement. Every started provider-plus-usage leaf is tracked. Native protocol outcomes, normal JSON, fanout/order, citations, usage, replay and private persistence retain their original owners. Diagnostic cancellation releases the real subscription during the initial read and on body cancellation, while late SQL remains observed.

The accepted cancellation-return decision is `cancel(): undefined`: it prevents TypeScript from silently accepting async cancellation. Its cost is an explicit synchronous facade for existing void-returning implementations. The facade must revoke delivery before returning; the type alone cannot certify remote cooperation.

No new operation/body/replay/page-cache/active-queue bound is introduced, and noncooperative work may exceed the existing cleanup wait. No workerd/CFW CPU, heap or latency gain was measured. The next priorities remain [the contract matrix's capacity policies and qualification](contract-matrix.md): define admission and retention policies, establish diagnostic gap/reconciliation semantics, compare representative local workerd workloads with the tagged deployed baseline, then complete catalog/affinity old-new rollback and release backup/restore qualification. This local acceptance is not a release recommendation.
