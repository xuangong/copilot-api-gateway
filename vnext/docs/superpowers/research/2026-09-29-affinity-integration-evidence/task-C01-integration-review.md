# C01 Responses/Messages production integration review

- Frozen base: `b09541c5988ab1c916b753d70c850964637ebaf3`
- Checkout reviewed: `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify`
- Input diff: `task-C01-integration-review.patch` (36 paths, 4203 lines, U18 context)
- Binding scope: `task-C01-brief.md`, `task-C01-production-next-interfaces.md`, implementation report, and root's explicit deferrals.
- Spec compliance verdict: **Changes Required**.
- Task quality verdict: **Changes Required**.

## Strengths and scope compliance

The change places authenticated source analysis at the source serve boundary, passes explicit request-owned context through hub traversal, materializes candidate clones, and uses provider-owned preparation and execution fences instead of stamping anticipated binding identity. Configuration authority checks incarnation/generation/owner/provider/enabled state. Copilot preparation reuses accepted model catalog/interceptor semantics without discovery. Claude's unavailable authority has a conservative projection/rejection policy. Responses item-done, terminal, and snapshot handling share asynchronous egress and closed-item authority. A14 exemption requires request-registered identity/value rather than a structural lookalike. Both protocol directions now preserve opaque values and signature companion whitespace.

Custom/Azure owner compatibility configuration, Chat/Gemini client carrier adapters, and full Claude account authority are explicitly deferred by root and are **not blocking findings in this slice**. This review does not claim overall C01 completion.

## Important findings

### 1. Bound signature buffering before the cross-protocol translator consumes more upstream chunks

**Location:** `vnext/packages/translate/src/responses-via-messages/events.ts:274`.

The new signature-delta branch concatenates every signature fragment into `info.signature` and yields no event. For a Responses client using a Messages upstream, gateway `responses/respond.ts:267-284` runs this translator before `AffinityEgress.responseEvent`. The bounded check in `AffinityEgress.messages` protects Messages source streams only; it cannot observe this translator's hidden buffer. Carrier encode eventually rejects an oversized finalized item, but only after the translator has accumulated all fragments or indefinitely waited for stop. This violates the required bounded signed-block buffering and permits upstream-controlled memory growth beyond the carrier limit.

**Verified focused reproduction:** called the exported translator with a thinking start, three signature deltas each containing `MAX_AFFINITY_PAYLOAD_BYTES` ASCII characters, and a stop. It consumed all three and produced an item with `encrypted_content.length = 3145728`, despite the 1048576-byte carrier limit. No gateway/product files were changed. The finite probe establishes late validation; indefinite growth follows directly from the unguarded concatenation while no stop arrives.

**Required correction:** enforce the applicable limit at the accumulation boundary for activated signed translation, surface a sanitized stream error, and close/cancel upstream iteration on overflow. Cover oversized multi-chunk signatures before stop, not only an oversized final carrier. Preserve normal text/tool behavior.

### 2. Final Responses companion text is ignored after any prior reasoning delta

**Location:** `vnext/packages/translate/src/messages-via-responses/events.ts:438-449`.

`closeReasoningItem` reads finalized `item.summary`, but sends that text only when no earlier reasoning delta exists. Any prior delta causes the full final companion to be discarded while the finalized `encrypted_content` is still emitted as the signature. Messages source egress then authenticates the already-streamed incomplete thinking with that final signature. The JSON adapter uses the complete final summary, so the two output forms disagree and replay can pair the native opaque value with incomplete companion text.

**Verified focused reproduction:** exported translator input `response.reasoning_summary_text.delta` with `delta: "a"`, followed by `response.output_item.done` with `summary: [{text: "ab"}]` and `encrypted_content: "native-signature-for-ab"`, emitted only `thinking_delta: "a"` and `signature_delta: "native-signature-for-ab"`. No `"b"` was emitted. This also applies when completion supplies the final item because `handleCompleted` calls the same closer.

**Required correction:** reconcile accumulated companion text with the finalized summary before emitting a signature. Append a safe missing suffix when final content extends prior deltas; reject an irreconcilable conflict rather than minting a carrier with mismatched companion. Cover partial-delta/final-summary and terminal-only-finalization cases, including JSON/SSE parity.

### 3. Nested required opaque slots are authenticated individually, allowing substitution within the same message

**Location:** `vnext/packages/gateway/src/shared/affinity/analysis.ts:61-78`, replay collection at `:90-93`.

`agentField` removes every `encrypted_content` value and constructs one identical field for all nested slots. Each carrier authenticates only its own value plus visible routing/content; it does not bind the set of other opaque values. Consequently one valid slot carrier can replace another in the same required agent message and all checks still succeed. This fails the binding requirement to bind all relevant opaque slots together using a two-pass scheme. This finding concerns the newly added nested agent-message support, not reopening the earlier program/fingerprint foundation.

**Verified focused reproduction:** stamp an agent message with two nested opaque values `A,B` under one target, replace the second signed carrier with the first, then run `analyzeAffinityRequest`. The result is `classify(target) === "exact"` and materialization contains `A,A`. This changes the required opaque collection without invalid-state rejection. The example does not require binding array indexes or forbidding permitted index changes.

**Required correction:** collect/authenticate the relevant original opaque values before constructing the shared canonical companion commitment, preserving the explicit no-array-index rule and avoiding freshly generated carrier bytes in that commitment. Add a regression for duplicating/substituting a slot, alongside allowed semantic movement and visible routing tamper cases.

## Full-CI gate and performance observation

Root's independent frozen full CI reported **4769 pass / 1 skip / 7 fail**. I inspected the supplied log around lines 4628 onward, not rerun the suite:

- Six `integration/messages-telemetry.test.ts` cases now receive HTTP 400. Root's writer is diagnosing the stub repo shape (`apiKeys.getById` is newly called). This review does not claim the exact cause independently established or treat those failures as a live production telemetry defect. The existing telemetry assertions must execute and pass before acceptance.
- `integration/warm-dispatch.test.ts:60` expected no pre-inference configuration SQL on a warm request but observed nine SQL operations. The log and unchanged test establish the contract regression.

The changed path provides a concrete amplification mechanism: `createRequestAffinity:17-19` performs authoritative key/secret reads for every stable-identity request; `selectAffinityCandidate:31-55` serially clones/translates and prepares **every** candidate even when `analysis.hasOwned === false`. Configuration authority `prepare` performs `repo.getById`; selected-provider preparation/fences also validate authority. With N candidates, preparation incurs O(N) serial work and full-payload clone/translation, including work for providers never selected. This is a bounded-by-candidate-count performance observation; no wall-time benchmark was measured. Authoritative reads may be deliberate for this security contract, so the correction must reconcile the accepted warm-dispatch contract and avoid unnecessary candidate work without weakening owned-state authority/fences. Do not simply suppress the failed assertion without an explicit contract decision.

## Inspection and evidence boundaries

- Read the complete supplied package diff, filling the initial truncated section with bounded reads. Follow-up unchanged-code inspection was limited to named risks: production Copilot fallback reachability, translator-before-egress ordering, Messages stream parser limits, and the failed warm-dispatch contract.
- Copilot deferred-token code can theoretically accept both stored credentials and fallback context, but **current production registry excludes that combination**: it passes `opts.copilot` only when stored `githubToken` is absent; discovery and control-plane calls pass undefined. Therefore the initially investigated authority/fallback concern is not a current production finding.
- Ran only three targeted read-only Bun probes described above. No product edits, index/HEAD changes, broad tests, or subagents were used.
- Implementer reports 1090 focused passes, 2898 assertions, 110 files, six package typechecks, and lint with zero errors plus one pre-existing warning. These are inherited evidence, not independently rerun here.
- Root reported passing Bun/SDK, provider, workerd/D1, and Codex runtime groups; this reviewer did not independently rerun them. Root remains owner of full CI and acceptance.
- Diff review cannot independently establish deployed OAuth/account replacement behavior, actual provider acceptance of replayed opaque values, network cancellation timing, or deployment health. No such end-to-end claim is made.

## Acceptance recommendation

Resolve the three Important findings and restore/explicitly reconcile the seven failed full-CI checks. Request a focused rereview of the fixes and associated meaningful regressions. The explicit deferrals above remain recorded boundaries rather than new blockers.

## Reproduction artifacts

- `task-C01-integration-review-repro.ts`: three independent deterministic probes, with exact nested input construction and expected invariants; uses the frozen verify checkout by absolute imports.
- `task-C01-integration-review-repro.jsonl`: captured output from the script, exit code 0. All three current failures reproduce.
- Copilot stored-credential plus fallback composition remains only a nonblocking interface-hardening observation: if future callers allow both contexts simultaneously, provider authority must follow the actual fallback credential or become unavailable. Current production callsites prohibit it.
