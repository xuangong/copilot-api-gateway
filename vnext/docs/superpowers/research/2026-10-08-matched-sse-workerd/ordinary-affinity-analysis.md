# Why the reference emits affinity on ordinary output

Verified reference: `1d7dcd923e260e425120cca0c7a240e93720af27`. Candidate: `963305f85654ff9b4fac28132739ec7ec9902e9a`. This analysis separates current consumption from the original feature's intent.

## Origin and current behavior

Reference commit `200c82f1b` (2026-07-17, #225) introduced client-carried upstream/model affinity. Every assistant turn gets an authenticated routing anchor, including turns with no natural opaque reasoning value. The native protocol slot carries the anchor back with client history, so routing need not depend on a gateway session lookup. The envelope authenticates the target and domain; it does not invent upstream reasoning state.

The implementation deliberately uses different native containers: Chat `reasoning_opaque`, Messages thinking signatures or synthetic `redacted_thinking`, Gemini thought signatures, and a Responses reasoning prefix or an in-place carrier. Synthetic metadata must be removed before the next upstream invocation. Responses additionally authenticates whether the entire item is synthetic (`fb5a8da3d`, 2026-07-28, #279), because dropping an item based on its shape or client-editable ID can destroy real data.

The original intent does **not** describe all current routing behavior. Commit `a2349daca` (2026-08-05) explicitly removed target preference when no natural state would be lost, preserving resolver first-available order. Current `chat/shared/affinity/selection.ts`, `projectOptionalAffinityBlob`, returns `remove`, `degrades:false`, `preferred:true` for an owned blob whose original value is absent (`decoded.value === undefined`, not an empty string), including an incompatible candidate. The adjacent reference test `candidate_test.ts`, “removes originless metadata without degradation”, asserts this directly. Therefore replaying an ordinary Chat empty carrier does not by itself make a session sticky to the old upstream/model, and no cache-hit or speed benefit may be inferred from its existence.

Natural opaque values are different: their authenticated compatibility identity determines whether a candidate can preserve them. Compatible candidates precede degrading fallbacks, while required state excludes incompatible candidates. This is the valuable common contract already implemented by vNext's source-bound, lazy affinity handling.

## Responses has an additional useful contract

Reference Responses ingress walks items in order and retains `latestOwnedTarget`. A blob-less `program`, `program_output`, `compaction`, or `compaction_summary` can inherit that target. It then requires an authorized compatible candidate, even if the earlier carrier had no original opaque value. The synthetic prefix is removed from the materialized upstream request after it has supplied provenance.

This is directly specified by reference `openai-responses/affinity/ingress_test.ts`, “derives force routing from blob-less program state after the turn carrier”. Its example replays a synthetic reasoning prefix followed by a client-created `program_output`; an incompatible upstream is rejected. A state item with a recognized foreign blob does not inherit force from the prefix. It does not reset `latestOwnedTarget`, so a later blob-less item may still inherit the earlier authenticated target. Optional `context_compaction` with no natural value is treated separately.

That contract is distinct from generic text-chat stickiness. A useful example is an upstream-generated program followed by a client-generated program result that has no fingerprint or encrypted content of its own. The routing anchor preserves the originating execution context across the client round trip. Keeping this state out of the gateway database also makes it usable on a stateless route, subject to the client returning the carrier intact. Affinity remains separate from stored item IDs and durable Responses history, as documented by reference commit `b7d94c804` (2026-07-18, #233).

## vNext assessment

Current vNext egress (`shared/affinity/egress.ts`, `AffinityEgress.item`) loads the codec only for existing signable opaque slots. Plain text does not require a secret, encryption, extra protocol items, or index rewriting. Existing opaque slots retain authenticated source/compatibility and companion-content binding. This is a justified optimization for ordinary Chat traffic under the reference's current optional-state routing semantics.

However, the current vNext affinity analyzer has no equivalent ordered `latestOwnedTarget` inheritance for a bare Responses program result. Its ordinary-output fast path must not be described as fully equivalent to every benefit of the reference's synthetic carrier. The real-workerd canary in this study explicitly checks that gap, separately from performance qualification.

Recommended direction: retain lazy ordinary Chat affinity, and evaluate a targeted Responses execution-provenance contract. Define which state-bearing output or continuation needs an authenticated origin, when a prefix is necessary, how a blob-less client result inherits it, and when incompatible routing must fail before dispatch. Do not attach synthetic reasoning to every protocol merely to imitate the reference. Preserve native opaque bytes, foreign-value handling, authorization boundaries, and the distinction between synthetic whole items and in-place metadata. Any new carrier contract requires versioning and old/new reader compatibility tests before release.

## Measurement implications

The B/R common Chat comparison has the same upstream SSE fixture, but R still performs extra empty-carrier work and emits extra downstream bytes. It measures the two complete behaviors. It does not measure the isolated cost of encryption, prove that all R work is unnecessary, or quantify the cost of the missing Responses provenance contract. Memory results are sampled whole-process RSS rather than exact isolate peaks.

The actual workerd canary confirms the Responses difference for both JSON and SSE: replaying an ordinary assistant output followed by a synthetic blob-less `program_output`, then selecting a model on another source, dispatches to that source on B and is rejected before secondary dispatch on R. This is a bounded provenance capability probe, not evidence of a real provider execution failure. See `results.md` for the run and remaining priorities.
