# Local workerd deployed comparison

Status: Freeze 04 / Canary 04 / Formal 02 completed; all 716 formal observations and both declared binary no-regression gates passed. Independent journal/CPU recomputation, full raw physical-evidence review and whole-increment review passed. The reviewed harness is integrated into local vNext; accompanying documentation and final head/preservation evidence are tracked by `local-integration-receipt.json` in the raw workspace. Formal 01 remains incomplete and is not pooled into this run. No push or deployment occurred.

The comparison uses deployed-source A (`e660fb4dfcf1734d10f89e52e2d739b2985c634b`, `vnext-deployed-20260928-233856`) and candidate B (`e90b8ee5a5feb6e99ef45cad8ca4463c245c25e7` plus the preserved collaboration overlay). The candidate product inventory is unchanged from the preceding resource-capacity qualification: 1,572 files; the commit alone does not reconstruct its 14 protected overlay files.

- [Specification](../../specs/2026-10-02-workerd-deployed-comparison.md)
- [Follow-up plan](../../plans/2026-10-02-workerd-deployed-comparison.md)
- [Deployed baseline compatibility audit](baseline-audit.md)
- [Sidecar terminal ownership audit](sidecar-terminal-audit.md)
- [Source-based hot-path cost map](hot-path-cost-map.md)
- [Harness qualification and preserved attempts](qualification.md)
- [Measured results and remaining priorities](results.md)
- [Full-precision result data and evidence hashes](results.json)
- [Previous runner readiness audit](../2026-10-01-resource-capacity-policy/workerd-readiness.md)
- [Independent rollback release gate](../2026-10-01-resource-capacity-policy/rollback-readiness.md)

Raw evidence is retained at `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix/.superpowers/sdd/2026-10-02-workerd-deployed-comparison`. Prior incomplete attempts remain unchanged in their original workspace and will not be combined with this experiment.

The frozen harness README describes the tooling contract and its implementation scope. Current execution status belongs to [results](results.md) and [qualification](qualification.md); tool bytes are preserved after freezing.

## Observation boundaries

| Evidence | What it can establish | What it cannot establish |
|---|---|---|
| 160 warmed ordinary timing requests | Local EOF and first-semantic latency with ABBA blocks | Cloud latency or real-provider throughput |
| 252 protocol matrix requests | Separate strict wire/capture outcomes and pass-to-fail comparisons for the fixed fixture | Universal compatibility or equivalence of both-failing cells |
| 160 separately profiled ordinary requests | Gateway-isolate sampled non-idle V8 time and settled heap | Billed CPU, process CPU, peak/RSS memory or leak proof |
| 144 separately counted warmups | Matched warmed states for six isolates | Cold-start performance |
| D1/KV/R2 and upstream readbacks | Physical persistence and exactly-once dispatch for completed units | Production D1/R2 or rollback-schema compatibility |

The formal collection has five fresh child units and exactly 716 logical offers. Canary and failed-run records are separate. Hosted-search saturation and diagnostic queue limits are outside this ordinary workload. CFW deployment, production access and push remain prohibited for this increment.

## Preparation evidence

Fresh protection checks confirmed the 38 MAIN and 14 isolated protected files, unchanged qualified product inventory and original fixture identity. A's third-party dependency symlinks are broken; the new build must use an explicit, hashed import-only resolver over exact-lock matching installed dependencies. A and B workspace code and generated assets remain separate.

Formal 02 observed two owned dump objects per A request and three per B request (1,790 total). The strict matrix records 19 A wire failures and four A capture failures; all matched B cells pass. Ordinary EOF medians increased by about 6% (JSON) and 7% (SSE), and sampled non-idle time did not fall. The final SSE settled used-heap observation is about 13% lower, without proving peak-memory reduction. See the results for full metrics, sampling limits and remaining release gates.
