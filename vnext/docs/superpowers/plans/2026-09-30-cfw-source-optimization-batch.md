# CFW source optimization batch

User direction: implement the agreed optimization list, then quantify the complete candidate once. Do not quantify individual changes or launch intermediate load/profile campaigns. This is an implementation subplan of the existing CFW P0 resource/rollback plan; completing it does not by itself close resource acceptance or rollback compatibility.

Specification: [source optimization priorities](../research/2026-09-30-cfw-resource-remediation/source-optimization-priorities.md).

## Global Constraints

- Work only in the existing `fix/cfw-resource-rollback` worktree. Preserve the 13 pre-existing collaboration overlay files and unrelated worktrees, services and evidence. Root owns staging and commits.
- Preserve authenticated affinity ownership, retry isolation, shared execution updates, cancellation, terminal-tail handling, transport errors and prompt HTTP completion. Do not hold HTTP completion for background dump persistence.
- Preserve dump content/format, complete external validation, borrowed-buffer snapshots, settlement of all started writes, staging/tombstones, optional-sidecar fallback and row/publication fencing.
- Do not change dependencies, caches, feature settings, retention, migrations, production deployments or old evidence to obtain a performance result.
- Add or update focused correctness tests for meaningful changed behavior. Use no per-item benchmark, heap snapshot or remote load. Run combined CI after implementation; quantify the final candidate using the existing workload and gates.
- Source, comments and documents are English; user updates are Chinese. Follow `vnext/AGENTS.md`. No nested subagents. Root coordinates integration, reviews and the final measurement.

## Task 1: Affinity preparation lifetime

Implement source-analysis items 1 and the affinity-analysis small allocation item. Separate input analysis from an actual shared execution-state object; only the routing/materialization boundary retains analysis. Turn, guard, egress and deferred terminal work receive lightweight shared state, preserving live actual identity and plaintext compactions through server-tools and cross-protocol attempts. Narrow complete-argument captures. Stop carrying/copying unused HTTP history while preserving durable completion writers, internal callers and WebSocket continuation. Filter actual opaque slots before unnecessary companion work only where semantics permit it. Preserve ordinary egress stamping and owned-marker fail-closed checks.

Ownership: affinity analysis/request/context and Responses serve/turn files plus focused tests. Coordinate any changes needed in the pre-existing dirty `responses/attempt.ts` with root before editing it. Do not edit output reconciliation in `shared/affinity/egress.ts`; root owns that separate block.

- [x] Implement and pass focused correctness checks.
- [x] Pass independent task review, including the three cross-protocol callback capture fixes.

## Task 2: Dump normalization and buffer lifetime

Implement source-analysis items 4, 5 and related header/helper small allocation fixes. Normalize internally constructed upstream envelopes once at a fully safe immutable boundary. Exact registered internal identities may reuse the complete safety projection; unknown/lookalike inputs continue through full validation. Retain budgets, counts, truncation metadata and borrowed finish identity. Avoid Blob copying for genuinely owned immutable byte inputs; borrowed bytes keep a snapshot. Consume raw preparation fields by stage, and release each compressed upload slot independently while awaiting all started writes. Do not stringify all bodies eagerly or increase compression parallelism.

Ownership: `shared/dump/upstream-attempts.ts`, `repo/dump-store.ts`, related dump interfaces if necessary, and their focused tests. Do not edit `shared/dump/accumulator.ts` or the generic dump-completion contract without coordinating with Task 3 through root.

- [x] Implement and pass focused correctness checks.
- [x] Pass independent task review.

## Task 3: Streaming demand and canonical dump completion

Implement source-analysis items 2, 3 and owned-header reuse in the accumulator. Make Responses/Chat/Messages SSE demand-driven with bounded encoded output and capacity-aware keepalive; first event remains immediate. Gemini is already pull-driven but canonical dump handling must not eagerly bypass client demand. Replace redundant tee/full response-byte collection on Chat/Messages/Gemini canonical paths with an explicit completion contract, retaining sent byte counts and actual transport errors. Preserve byte capture on passthrough/noncanonical errors and never choose mode merely because events are initially empty. Preserve terminal-tail validation, cancellation, cleanup and prompt HTTP completion independently of background persistence.

Ownership: the four protocol responder files, generic `chat-flow-kit` serve/dump contract, dump accumulator and focused tests. Do not edit Responses `serve.ts`/`turn.ts` (Task 1) without asking root to coordinate the interface.

- [x] Implement and pass focused correctness checks.
- [x] Pass independent task review, including cancellation task settlement, observed scalar handoff and demand-independent bounded Chat tail fixes.

## Task 4: Per-frame and output-item overhead

Implement source-analysis items 6 and 7. Replace repeated per-read abort Promise/listener setup with one consumer listener and explicit pending-read state, preserving upstream and canonical protections and an absolute post-terminal deadline. Do not accumulate reactions by repeatedly racing a never-settling shared Promise. Reuse or add an exact allocation-free UTF-8 length helper, preserving Unicode/surrogate semantics. Apply it only to length-only paths. Replace repeated output-ID scans with indexed matching, preserving authoritative terminals, missing-ID position matching, deduplication and extras.

Ownership: shared `stream-tail.ts`, UTF-8 helper/call sites, `protocols-llm/responses/final-output.ts`, output-reconciliation block in affinity egress, and focused tests. Coordinate affinity egress imports/types with Task 1. Do not modify the preserved protocol event/stream overlay.

- [x] Implement and pass focused correctness checks.
- [x] Pass independent task review.

## Task 5: Combined review and final measurement

Review integrated interfaces and changes, run exact combined CI once after implementation and fixes, then use the existing controlled ordinary and size/history resource gates to quantify the complete candidate. Preserve original baseline provenance limits, all failures, deployment receipts and restoration records. No isolated optimization metrics are required. Update the parent plan item-by-item and summarize remaining resource/rollback gaps. Only reviewed passing work is eligible for authorized integration into vNext; this subplan does not authorize production deployment.

- [x] Complete combined source review and CI: frozen CI03 passes 5,384 tests with 2 skips, 0 failures and 228,953 assertions; all other CI stages pass and 2,329 source hashes remain stable. CI01/CI02 failures remain archived. Same-lock dependency reuse is not a clean-install proof.
- [x] Quantify final candidate and document outcome against unchanged gates. Node canary/ordinary/large/history complete 16/4,000/80/20 successful requests with exact dispatch and task retirement. All 30 initial/delayed raw platform windows match. Ordinary CPU p50/p95 fail 5/5 pairs, memory p99 fails 2/5 and client p95 fails 6/10; this is completed measurement, not resource acceptance. Preserve the earlier Bun driver failure. The isolated Worker is restored with version/settings/retention readback. See the [final report](../research/2026-09-30-cfw-resource-remediation/source-optimization-results.md).

Source-only commit `cdd2eb5ceb6ae991b1c5ec61d459f4cf22e0b03b` remains on the repair branch. The tested complete artifact also contains the preserved collaboration overlay. Resource acceptance failed, so vNext integration and production deployment remain pending; no push occurred. The next priority is source analysis of ordinary Responses' remaining CPU overhead, followed by memory variability and the separate catalog/affinity rollback work.
