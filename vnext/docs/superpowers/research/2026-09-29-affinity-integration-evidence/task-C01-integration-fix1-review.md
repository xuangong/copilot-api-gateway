# C01 integration fix1 scoped re-review

- Frozen product base: `b09541c5988ab1c916b753d70c850964637ebaf3`.
- Reviewed `task-C01-integration-fix1-review.patch`: 16 changed files relative to the first reviewed candidate, plus original review, fix1 brief, and appended implementation report.
- Verified all 36 current owned file SHA-256 values match `task-C01-integration-fix1-frozen-sha256.json`; zero mismatches.
- **Spec compliance verdict: Changes Required.**
- **Task quality verdict: Changes Required.**

## Original findings disposition

| Original finding | Disposition | Evidence |
| --- | --- | --- |
| 1. Unbounded cross-protocol signature accumulation and required upstream termination | **NOT ADDRESSED (partially fixed)** | New guard is correctly before both source translators/reassemblers and bounds accumulation before it becomes hidden. Async iterator unwinding reaches parser reader cancellation. However root's independent supported-runtime controls establish that Bun 1.3.0 `reader.cancel()` alone does not close the live HTTP upstream; explicit request AbortController abort does. Actual upstream termination remains unfinished; see below. |
| 2. Partial thinking paired with finalized signature | **ADDRESSED** | `messages-via-responses/events.ts:448-455` compares final summary with streamed text, emits a safe suffix, and throws before signature on irreconcilable conflict. Both item-done and terminal-only finalization use the same closer; added regressions cover them. Root reports all three actual companion HTTP groups passed. |
| 3. Nested A,B to A,A substitution | **ADDRESSED** | New group-v2 domain commits to sorted original-byte digest multiset before stamping. Replay builds candidate AAD from public originals then authenticates owned slots. Duplication changes commitment; opaque-slot exchange preserves it. Single-slot legacy AAD remains unchanged; previously unaccepted legacy multi-slot carriers fail closed. Root reports actual nested duplicate HTTP test passed. |

### Original seven CI failures

All seven are **ADDRESSED**, based on inspection of the unchanged fixtures and `/tmp/c01-fix1-final.log:1025-1039`, not a duplicate test run:

1. Warm owner-shared keys and translated zero-configuration-SQL dispatch: PASS.
2. Successful Messages streaming usage/performance: PASS.
3. Mapped source/public model identity: PASS.
4. Upstream-error 401 usage/performance: PASS.
5. Post-binding parse failure performance: PASS.
6. Pre-binding missing-model telemetry: PASS.
7. Executed model-key correction: PASS.

Neither telemetry mocks nor the warm test's zero-SQL assertion were relaxed. No-owned requests skip all-candidate preparation and defer key/secret access until signable output. This removes the original N-candidate serial preparation amplification for that path. The implementation report states 1105 affected tests pass; full CI remains root-owned and was still running at the time of this report.

## Remaining original Important: overflow must abort the actual upstream transport

**Changed entry points:** `vnext/packages/gateway/src/shared/affinity/egress.ts:27-75`, called from both source responders before translation/reassembly. Relevant error branch: `gateway/src/data-plane/chat-flow/responses/respond.ts:296-307` (Messages has the analogous branch).

The guard throws and stops consumption; it does not invoke a request-owned transport AbortController. The responder's failure handler emits an error and finalizes telemetry but does not abort upstream. The existing downstream cancellation branch does invoke `downstreamAbortController.abort()`, demonstrating the available cancellation mechanism, but a guard error never reaches that branch.

I inspected the named unchanged chain: guard for-await unwinds; `translateStream` finally calls iterator.return; telemetry uses for-await and forwards return; `parseMessagesStream` reaches `result/src/parse-sse.ts` finally, which calls `reader.cancel()` and releases its lock. Thus no claim is made that the generator return chain is broken.

Root supplied stronger runtime evidence after separating platform behavior from fixture observation:

- `task-C01-bun-cancel-control.mjs`: direct Bun fetch/read/reader.cancel without gateway still leaves the upstream producing chunks.
- `task-C01-node-upstream-cancel-control.mjs`: independent Node HTTP upstream `res.close` does not fire within 600 ms after Bun reader.cancel.
- The same control with `EXPLICIT_ABORT=1` closes immediately (`sent: 1`, `finished: false`). Logs: `/tmp/vnext-c01-cancel-node-control.log` and `/tmp/vnext-c01-abort-node-control.log`.

These runtime results are root-provided evidence, not independently rerun. They demonstrate why unit generator `finally` execution is insufficient to satisfy the original actual-upstream-stop requirement on the supported Bun runtime. Wire an overflow/invalid-state failure to request-owned upstream abort while retaining the sanitized client error, failure telemetry, and existing client-cancellation semantics; do not drain the rejected source for usage. Root should repeat the actual socket-close test after correction.

## New Important introduced by fix1: arbitrary tool data is classified as native opaque state

**Location:** `vnext/packages/gateway/src/shared/affinity/egress.ts:34-43`, specifically recursive key-name matching at lines 37-39.

`checkItem` recursively visits every object and checks any string named `signature`, `encrypted_content`, or `fingerprint` against the carrier limit, regardless of its protocol location. It also treats arbitrary nested `type` strings as native block types. A normal tool's JSON input can legally have such fields. Those are application data, not an affinity carrier or native opaque block. Because `guardAffinityFrames` activates for every stable-identity request, even before any actual target/codec exists, a valid tool response can now fail with invalid-affinity-state without any affinity state being present. This violates the brief's preserved normal text/tool behavior.

**Independent minimal reproduction (saved and run):** a Messages `content_block_start` containing `{type:"tool_use", id:"t", name:"store_document", input:{signature:"x".repeat(1048577)}}`. No native thinking/signature state is present. With no request context it passes unchanged; with a real no-owned analysis and stable request context it throws `invalid_affinity_state`. This is a semantic false positive, not a request to increase native carrier limits.

Artifacts:

- `task-C01-integration-fix1-review-repro.ts`
- `task-C01-integration-fix1-review-repro.jsonl`

**Required correction:** bound only native fields at known protocol event/item/block positions. Do not recursively inspect arbitrary tool input, result, text payload, or metadata for reserved-looking property names. Add ordinary tool data pass-through coverage alongside the existing native opaque overflow regressions, through actual route JSON/SSE where practical.

## Lazy capture and permission audit

No additional blocking issue was established in the new lazy provenance path:

- Configuration authority snapshots primitive id/provider/owner/incarnation/generation at provider construction. `capture` derives identity from that immutable snapshot; it does not relabel execution with a later row read.
- Custom and Azure store credential strings in their constructed provider. Custom uses the actual payload model; Azure uses the same deployment resolver as its OpenAI URL path and the Anthropic body-model distinction. Copilot's token preparation/forced refresh closures capture the stored GitHub token/account/host, and actual variant selection supplies the captured executed model. Current production registry still excludes stored-token plus per-request fallback composition.
- Owned markers trigger eager `loadCodec` and authentication before selection. Existing owned-state selected-target guard still causes provider authoritative preparation and refresh/inference fencing. No-owned capture does not weaken that branch.
- `loadCodec` verifies current key-owner equality and secret initialization, throwing invalid-state on failure. The memoized production loader returns a codec or rejects; it does not resolve undefined and raw-fallback. Egress requests it before the first signable item. Root's actual lazy HTTP tests report owner-change failure without raw opaque output and required replay rejection after configuration change with zero extra inference.
- Accepting actual response provenance checks any selected and previously actual identity before updating context. No new weak ownership inference from a catalog alias was added.
- Persistent terminal representation, closed opaque item reuse, source merged-input ownership, and whole-block projection logic were not loosened by this fix diff.

## Scope and evidence boundaries

Only the fix diff and named unchanged callsites necessary for provenance/cancellation were reviewed. I did not rerun existing suites, root HTTP tests, or socket controls. I ran only the new tool-field false-positive reproduction and read-only SHA-256 verification. No product edits, Git/index mutations, commits, push/deploy, or subagents.

Root additionally reports passing frozen app 27 groups, companion 3 groups, providers 6 groups, D1 5 groups, and lazy 3 groups. These are inherited root runtime evidence. The actual overflow transport stop is explicitly not claimed as passing.

Original deferrals remain unchanged: owner compatibility producer, Chat/Gemini client adapters, full Claude account authority, and hypothetical future Copilot fallback API composition. They are not new blockers in this review. No unrelated foundation or whole-branch review was opened.

## Recommendation

Proceed to a narrow fix2 for request-owned transport abort on guard failure and protocol-position-specific native size checks. Preserve the already successful original companion/nested/CI corrections and request a focused rereview.
