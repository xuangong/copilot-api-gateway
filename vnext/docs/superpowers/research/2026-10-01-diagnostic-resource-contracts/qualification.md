# Diagnostic resource contract qualification

Date: 2026-10-01. Local architecture increment completed and qualified. No push, deployment, production access, benchmark, dependency installation or existing-service restart was performed.

## Exact artifact and integration

| Item | Verified result |
| --- | --- |
| Batch baseline | `f6797d50a797a2633d60128593861349038f0300` |
| Capture implementation and correction | `0c53ce12397fb73d9c4d8b7925ac636418c4de8f`, `2f0a23e01103f70c1c41ee8a5c3e8a7eaa5d6670` |
| Subscription implementation / last source commit | `2f09a995b9192afb40e1ad1c646d20fd4d8d4a7c` |
| Reviewed and frozen CI HEAD | `ccc92ab2921c26023b91daea7c7d8a295f419860` |
| Qualified source files | 1556 tracked/nonignored source, configuration and test files under `vnext`, excluding Markdown and `vnext/docs` |
| Source manifest SHA-256 | `59b7aeef3a41ed1f96a954b4f392c00348e1c06c8e108c4db69cb2e9fa99df28` |
| Protected modifications | All original 38 main and 14 isolated files retain their original SHA-256 values; neither set was staged |
| Qualified overlay | The 14 original isolated modifications are included in the frozen source manifest; this is not qualification of the clean committed tree alone |
| Local integration | Main checkout on `vNext` fast-forwarded from the batch baseline to the reviewed CI HEAD; both complete source manifests match the frozen artifact |
| Existing fixture | PID `90455`, command `bun`, original start `Wed Sep 30 05:16:07 2026` preserved |

The closeout commit contains only documentation. Its local integration is checked against the same source and protection manifests, with both indexes empty; the final commit and verification results are retained in `integration-result.json` beside the raw evidence. The worktree, original modifications and raw evidence are retained. No second full CI is needed for a documentation-only fast-forward with identical complete source hashes.

## Final complete verification

Exactly one complete CI was run after all source fixes and independent reviews, from the isolated `vnext` directory:

```sh
SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local
```

| Gate | Result |
| --- | --- |
| Complete command | Exit `0` |
| Bun suite | **5,713 pass, 1 skip, 0 fail**; 5,714 tests across 544 files |
| Package typechecks | 26 succeeded |
| Framework purity | Passed |
| Lint | 0 errors, 34 warnings; warning messages match the previous batch in order |
| Setup and dashboard builds | Passed |
| Cloudflare Worker bundle | `deploy:dry` exited `0`, with `--dry-run: exiting now`; no deployment |
| Post-CI isolated source | All 1,556 hashes match the frozen manifest |
| Post-integration source | Both complete manifests match; original main38/isolated14 hashes still match |

The skip is the existing runtime X25519 invalid-key derivation case. Scoped lint also emitted the existing multiple-tsconfig resolver advisory (M1); it was independently reviewed as a nonblocking tooling follow-up, not hidden or called warning-free.

Raw output, exit code, frozen manifest/metadata, protection manifests and progress remain at `.superpowers/sdd/2026-10-01-diagnostic-resource-contracts/` in `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`. These are local retained artifacts. Task-level RED/GREEN results are in the archived reports; they do not substitute for this frozen-source complete CI.

## Delivered contracts and review outcome

- Capture admission cannot mutate raw shared counters or release/retire the owner. First retirement binds one receipt; each phase is independently observed, both outcomes are awaited, preparation-error precedence is preserved, and post-retirement admission refuses. The audit found an unsafe public capability, not a demonstrated production caller abusing it. Existing 4 MiB / 16 MiB / 8,192-frame policies and accumulator/storage/completion owners remain unchanged.
- Channels exist only while subscriptions are active. No-recipient publication skips encoding and channel/event allocation. Graceful close preserves FIFO while cancellation discards it and settles pending reads; same-ID recreation and repeated cleanup cannot steal ownership. One subscription has one sequential iterator state.
- The Task 1 independent review found and reproduced a synchronous Promise observation failure that could leave retirement pending and charges retained. The fix and eight regression cases passed re-review. Task 2 self-review caught decode-triggered cancellation requeueing; the post-decode guard and regression passed its independent review. [Final review](final-review.md) found no remaining Critical/Important issue.
- The [contract matrix](contract-matrix.md) extends the previous preparation, producer, ready-capability, normalizer and private-state inventory. The [source audits and follow-up](resource-contract-followup.md) retain reference strengths and explicitly identify unimplemented capacity decisions. The earlier S10 design is annotated as a historical baseline where its capture-cap statement became stale.

Decision recorded during implementation: graceful close releases delivery listeners and the channel entry immediately, but retains one abort listener while a residual FIFO remains. This is necessary for abort-after-close to discard queued values before another pull. The cost is that listener's lifetime until drain/cancel; the final pull or cancellation removes it.

## Remaining priorities and release boundaries

1. Define hosted-invocation operation admission before parser expansion, slot creation and eager provider starts, shared across calls and reentries. Define overflow through the existing failure owner. Then separately qualify success-body ingestion, private replay and page-cache retention; a late Map limit cannot prevent earlier provider peaks.
2. Define active diagnostic queue and aggregate publication admission, with observable overflow/reconciliation and bounded preview/UI history. This increment removes inactive ownership but does not bound slow-consumer queues, metadata task count or full detail expansion.
3. Compare representative local workerd CPU, heap/memory and latency against the tagged deployed baseline using an exact release candidate. Two native phase-observation receipts are added per first capture retirement, while no per-frame wrapper or clone is added. Source-level avoided work and lifecycle fixes are not a measured net resource improvement.
4. Qualify catalog/affinity upgrade and mixed-version rollback with backup/restore verification before any CFW deployment decision. Reconcile the preserved collaboration overlay into an explicit release artifact; current CI includes it without committing it.

Workers dry-run proves local bundling only. No production effectiveness, global isolate bound, clean-install result or deployment readiness is inferred from this qualification.
