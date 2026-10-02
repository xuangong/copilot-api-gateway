# Local workerd comparison results — Formal 02

The full experiment collected 716/716 requests and passed its declared two binary no-regression gates. The candidate fixes all 19 baseline wire-oracle failures and all four baseline capture-fidelity failures in this fixture. Ordinary latency is somewhat higher, sampled non-idle time is not lower, and the final SSE settled-heap observation is lower. These results do not establish release readiness or a general reduction in memory or CPU.

Status: independent metric recomputation, full raw physical-evidence review and whole-increment review passed. The six reviewed harness commits were fast-forwarded into local vNext at `c3f5923fe406675ec7a95c68d72485714f117590`; this documentation accompanies that local delivery. Final branch heads and preservation checks are recorded in `local-integration-receipt.json` under the raw root. No product behavior changed in this increment. No push or deployment occurred.

## Identity and method

- A: deployed-source `e660fb4dfcf1734d10f89e52e2d739b2985c634b`, tag `vnext-deployed-20260928-233856`, unchanged and clean.
- B: product base `e90b8ee5a5feb6e99ef45cad8ca4463c245c25e7` plus the preserved 14-file collaboration overlay. The frozen checkout HEAD is `c3f5923fe406675ec7a95c68d72485714f117590`; its intervening commits change only the comparison harness. The qualified 1,572 product-file inventory remains identical. HEAD alone does not reconstruct the overlay or ignored assets.
- Experiment `00c2f87e-4e64-470b-a770-edda1aa3e1a9`, Freeze 04 manifest SHA-256 `75b56a29dfa45e59360323ace390d2c8eb5d2a4fd5e40a8aefac69e755d8434d`; separate Canary 04 passed four requests / ten objects.
- Bun 1.3.0, Miniflare 4.20260601.0, workerd 1.20260601.1, Wrangler 4.97.0, compatibility date 2025-06-01. Both bundles use the same reviewed build options and exact-lock dependency resolver. Existing variant-specific assets and schemas are preserved.
- Local macOS 26.7 / arm64 / 12 CPU cores / 24 GiB RAM; existing user services were preserved. No claim of isolated host scheduling. Implementation tests and large audit scans were stopped during the formal experiment.
- Fixed 64 KiB deterministic request, three eligible providers, dump persistence enabled, Responses history retention disabled, and local synthetic upstream. Five fresh children: latency pair 208, A matrix 150, B matrix 150, B diagnostics 104, A diagnostics 104. The totals are 144 warmups, 160 ordinary timing requests, 252 matrix cases, and 160 diagnostic requests.
- Ordinary A/B timing uses concurrently warmed isolates and AB/BA/AB/BA blocks, without Inspector. Diagnostic windows are separate, B then A, 40 requests per mode with background settlement included. No forced GC or heap snapshots.

The [machine-readable results](results.json) retain full precision, block observations, heap fields, failure cells and source artifact hashes. Raw artifacts remain in `.superpowers/sdd/2026-10-02-workerd-deployed-comparison/` in the retained repair worktree. Earlier failures are documented in [qualification](qualification.md) and are not pooled into Formal 02.

The independent physical audit reparsed all raw responses, checked all 716 formal requests / 1,790 owned objects and the separate four-request / ten-object canary, and recomputed the fixed-fixture outcomes without importing harness helpers. It rehashed all 9,536 unique frozen input files; all 2,825 original evidence files remained byte-identical after inspection of copied databases. Exact Inspector targets, dispatch, settlement and process cleanup passed. The 39,523 consistency checks report zero problems. Detailed scope and exceptions are recorded in `formal-02-evidence-review.md` and `formal-02-independent-audit/result.json` under the raw root.

## Verification and reconstruction costs

| Decision | Benefit and remaining cost |
| --- | --- |
| Keep the executable harness under tracked research | Preserves the old harness/evidence and product inventory; regular product test discovery does not cover it, so its 39 focused tests and standalone typecheck are explicit gates. The separate analyzer has 32 synthetic filesystem tests. |
| Reuse the existing worktree and dependencies | Avoids installation, service disruption and redundant product CI. Reuse of the preceding 5,880-pass / one-skipped product qualification depends on fresh equality of all 1,572 actual product files; it does not qualify the new harness or prove a clean install. |
| Build both variants through the exact-lock import resolver | Leaves broken baseline third-party links and source unchanged. These are matched local builds with separately preserved module-resolution evidence, not byte-identical reproductions of the historical cloud bundle. |
| Permit two explicit published-package dependency omissions | `@reclaimprotocol/tls@0.1.2/lib/crypto/common.js` imports `@peculiar/asn1-cms` and `@peculiar/asn1-rsa`, resolved through each variant's declared HTTP dependencies and identical 2.8.0 lock entries. This narrow build compatibility rule, installed dependencies, protected overlay, ignored assets, manifests, bundles/maps and resolved-module records must travel with the evidence. A commit checkout alone cannot reconstruct the experiment. |
| Separate physical collection from matrix outcomes | Measures defects in an immutable baseline without relabeling them as successes. It adds per-cell outcome joins and two regression gates to the measurement tooling; ordinary and physical validation remain strict. |

Exact commands and schemas are in the [harness README](harness/README.md), with source/dependency context in the [baseline audit](baseline-audit.md). Preserve the ignored raw workspace and frozen bundles alongside the tracked documents; the recorded paths are local evidence locations, not a claim of a portable clean-checkout reproduction.

## Ordinary request latency

Each row has 40 samples per variant. Values are milliseconds, nearest-rank percentiles. Percent changes are descriptive observations of this run, not confidence intervals or production forecasts.

| Metric | A | B | Change |
| --- | ---: | ---: | ---: |
| JSON EOF p50 | 13.669 | 14.498 | +6.07% |
| JSON EOF p95 | 25.533 | 21.659 | -15.17% |
| JSON first semantic p50 | 13.674 | 14.502 | +6.05% |
| JSON first semantic p95 | 25.540 | 21.667 | -15.16% |
| SSE EOF p50 | 66.258 | 71.002 | +7.16% |
| SSE EOF p95 | 94.165 | 102.156 | +8.49% |
| SSE first semantic p50 | 45.392 | 50.194 | +10.58% |
| SSE first semantic p95 | 72.582 | 83.857 | +15.53% |

For JSON, semantic interpretation happens after observing EOF, hence its slightly later timestamp. SSE semantic timing is recorded while consuming the stream.

| ABBA block | JSON A/B EOF p50 | SSE A/B EOF p50 | SSE A/B first semantic p50 |
| --- | ---: | ---: | ---: |
| 0 (A then B) | 13.170 / 15.399 | 64.097 / 77.219 | 40.335 / 48.722 |
| 1 (B then A) | 17.158 / 14.833 | 71.294 / 70.292 | 45.474 / 50.194 |
| 2 (A then B) | 12.000 / 13.115 | 63.091 / 68.790 | 41.572 / 48.083 |
| 3 (B then A) | 13.669 / 14.374 | 62.421 / 73.913 | 41.809 / 52.343 |

Both JSON and SSE EOF block differences change sign, so a single aggregate percentage should not be treated as a stable throughput penalty. SSE first-semantic medians are higher in all four B blocks, making pre-first-event work a concrete optimization focus for this fixture.

## Sampled isolate time and observed heap

| Diagnostic metric | A | B | Change |
| --- | ---: | ---: | ---: |
| JSON sampled non-idle ms/request | 12.591 | 17.309 | +37.48% |
| SSE sampled non-idle ms/request | 69.531 | 71.335 | +2.59% |
| JSON settled V8 used heap, MiB | 27.464 | 27.515 | +0.18% |
| SSE settled V8 used heap, MiB | 32.056 | 27.980 | -12.72% |

These are separate diagnostic observations, not latency measurements with Inspector overhead mixed in. CPU values are independently recomputed weighted V8 non-idle samples, including settlement. They are not billed CPU, process CPU, or a per-feature causal allocation. Only 72/112 total samples were recorded for A/B JSON and 262/360 for A/B SSE; sample weights do not cover the entire profile wall window. Sparse samples and runtime/native/anonymous frames limit precise attribution.

Heap is `Runtime.getHeapUsage().usedSize` after settlement without forced GC. JSON begins at 23,009,124 / 26,907,148 bytes for A/B; the next SSE mode starts at the preceding JSON settled value. Different code/assets, allocations, GC timing, and mode order remain represented. Total heap, embedder and backing-storage observations are retained in JSON; they are not interchangeable with used heap. The lower B SSE settled value is not evidence of a lower peak, a resolved leak, or compliance with Cloudflare's memory limit. JSON settled used heap is essentially unchanged in this run.

## Profile interpretation and optimization leads

Independent interpretation checked sampled functions against the frozen bundle bodies, module comments and matching source content. It confirms that B executes owned capture projection, affinity input traversal, upstream observation and terminal/settlement work. It does not establish a per-feature cost allocation or a net CPU saving from the new renderer or removed response tee.

The next investigation order is:

1. **JSON: per-request dial/proxy preparation.** B has two `createPerRequestFetcher` samples totaling 69.465 ms of weight, compared with one 4.521 ms A sample over their respective 40-request windows. Source confirms that all-visible preflight and selected-authoritative fetcher preparation both remain. This is a sparse lead for reducing repeated construction and configuration copying; it neither explains the aggregate JSON delta nor determines a safe cache lifetime. Preserve current failure semantics, authoritative credentials/proxy observations and request-local ownership.
2. **SSE: upstream observation and persistence preparation.** B has 19 sampled bundle leaves in `shared/dump/upstream-attempts.ts`, totaling 216.794 ms of weight, including response wrapper pulls and header work. This repeated signal supports inspecting observer wrapping, prefix capture and dump preparation separately from settlement compression/storage. Native stream and binding-wrapper weights cannot all be charged to the sidecar. Complete capture and its owned object remain required.
3. **Owned projection and affinity traversal.** Their B stacks are directly observed, but have too few samples to quantify an isolated cost. Improve repeated container traversal or serialization only while retaining independent frame ownership and the four demonstrated capture fixes.

Some direct source-map lookups at V8 function declaration coordinates disagree with the actual frozen bundle function, even after zero/one-based conversion and adjacent-body checks. These particular coordinates are unsuitable for fine source-line attribution; this is not evidence that the entire map is corrupt. The report uses bundle-checked coarse anchors and avoids source-map-only feature totals. No positive-weight TLS/ASN.1 dependency leaf or ancestor appears in any of the four warm profiles; this experiment provides no basis for prioritizing TLS initialization and does not measure cold starts.

Detailed evidence is retained as `formal-02-profile-interpretation.md`, `formal-02-profile-analysis-final.json`, `formal-02-source-map-lookup-check.json` and `formal-02-profile-input-preservation-and-tls.json` under the raw root. All 12 original profile/summary/bundle/map inputs retained their hashes. No runtime was rerun for this interpretation.

## Protocol and capture outcomes

| Independent oracle | A failures / 126 | B failures / 126 | A-pass/B-fail | A-fail/B-pass | Unresolved both-fail |
| --- | ---: | ---: | ---: | ---: | ---: |
| Strict client wire semantics | 19 | 0 | 0 | 19 | 0 |
| Persisted response comparison | 4 | 0 | 0 | 4 | 0 |

All ordinary canary, warmup, latency and diagnostic observations pass both strict checks. The wire improvements cover preserved text/tool streaming, refusal semantics and fault/truncation paths that previously reported false success. Every failed baseline cell and reason is retained in `results.json`; the complete paired outcomes and raw evidence remain in Formal 02.

The four capture improvements are Responses ingress translated from Messages for ok/tool/refusal/slow SSE. A persists mutated early `response.output` arrays; B's stored early events now match their original wire events. This is the observed counterpart to the owned-projection mechanism described in the [cost map](hot-path-cost-map.md). Preserving frame ownership is therefore a correctness requirement when optimizing capture.

The persisted comparator is deliberately labeled by domain: SSE compares emitted event values and DONE evidence, allowing only the reviewed renderer-appended error boundary; JSON validates producer-domain canonical semantics; byte descriptors compare original wire bytes. It is not a universal byte-equality assertion across protocols. Binary no-regression qualification only applies to these declared fixtures and oracles.

One inherited B status distinction remains explicit: the Responses-from-Messages JSON policy-refusal cell (`B_56`) returns HTTP 200 with a failed policy envelope, while dump metadata records status 502 and error kind `failed`. The reader accepts only this previously reviewed, exact refusal/transport/producer shape and retains `statusEvidence`; it does not claim universal wire/dump status equality or absence of every product issue. This distinction was not introduced or repaired in this increment.

## Persistence cost

| Full formal storage | A (358 requests) | B (358 requests) |
| --- | ---: | ---: |
| Dump rows | 358 | 358 |
| Owned objects | 716 | 1,074 |
| Request compressed bytes | 97,428 | 97,493 |
| Response compressed bytes | 139,649 | 139,778 |
| Upstream sidecar compressed bytes | 0 | 512,447 |
| Total compressed bytes | 237,077 | 749,718 |
| Total decoded bytes | 24,068,192 | 56,083,178 |

B writes one additional sidecar per request: 358 extra objects and 512,447 compressed bytes in this run. Core request/response storage is almost unchanged. The synthetic repeated payload compresses extremely well; these totals are not representative production compression ratios or a storage-bill forecast. More objects do not imply an unconditional extra SQL statement: staging and dump-row descriptors are batched by the existing writer. Readback observes 1,790 owned objects in total and zero retained Responses snapshot/item rows.

## Next priorities and release gaps

1. Optimize ordinary pre-dispatch and pre-first-event work while preserving contracts. The latency observations prioritize SSE first-semantic cost; the separately sampled JSON increase also warrants inspecting per-request construction, wrappers, encoding and persistence setup. Use sampled functions checked against the frozen bundle and source as leads, not proof that one feature caused the entire delta.
2. Keep the new immutable capture ownership, strict terminal/fault semantics and demand-driven delivery. Reduce repeated preparation and serialization at their boundaries; restoring borrowed mutable frames would reintroduce the four observed defects.
3. Measure local large-request/concurrent/slow-consumer peak pressure under the existing resource policies before claiming the memory-limit problem solved. This sequential ordinary workload does not cover hosted-search saturation, replay/page limits or diagnostic queue exhaustion. Cloud billed CPU and production memory behavior remain unmeasured; no CFW deployment is authorized in this increment.
4. Implement and qualify [catalog/affinity rollback compatibility](../2026-10-01-resource-capacity-policy/rollback-readiness.md), including a separately identified safe rollback artifact, migrated-data code switching, and backup/restore evidence. The old deployed tag alone is not proof that new affinity carriers can safely return to old code.

This increment integrates reviewed measurement tooling and documentation locally, with product bytes unchanged. The observed protocol improvements do not establish that the candidate is faster overall, that general memory use is lower, or that it should be deployed now.
