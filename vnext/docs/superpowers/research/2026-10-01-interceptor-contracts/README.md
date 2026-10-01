# Interceptor responsibility contracts

Date: 2026-10-01. Baseline: local `vNext` `c3a36551` with the separately preserved collaboration overlay. Follow the [design](../../specs/2026-10-01-interceptor-contracts.md) and [implementation plan](../../plans/2026-10-01-interceptor-contracts.md).

## Reference advantages and concrete adoption

The reference's most useful ideas for this slice are reusable synchronous payload helpers, result-independent payload interceptor types, typed dependency contexts, and explicit chain-order reasoning. [Reference audit](reference-audit.md) identifies the actual files at `1d7dcd923e260e425120cca0c7a240e93720af27`; [current audit](current-audit.md) maps all 35 gateway interceptors and the provider membrane at the inspected vNext baseline.

| Reference advantage | vNext implementation direction | Benefit |
| --- | --- | --- |
| Gemini payload helpers separate request shaping from invocation | `RequestTransform<Req>` and `beforeRequest` in the domain-neutral service package | A synchronous request correction need not control downstream execution |
| Messages payload interceptors are independent of concrete output | Gateway `withRequestNormalization` exposes only payload and flags to the callback | Request-only code cannot inspect/replace a stream or invoke `next` through its declared interface |
| Typed contexts expose dependencies | Preserve the original Invocation through a narrow parameter type | Whole-payload replacement still reaches the terminal, without copying a temporary view |
| Ordered chains explain semantic dependencies | Keep registry positions and add real-chain behavioral checks | Forced-tool reasoning reaches vendor rewriting; empty-tools policy runs before reasoning decisions; tool-loop suffixes rerun |

The narrowed contract strengthens a gap still present in the reference: a normalizer receives no `next`, context or result. `undefined` return typing excludes accidental async callbacks. The adapter owns one delegation per successful entry; an outer tool loop may enter it repeatedly. This is a trusted-code API boundary, not deep immutability or runtime security isolation.

## Responsibility and ownership map

| Role | Allowed responsibility | Actual examples |
| --- | --- | --- |
| Synchronous request correction | Mutate/replace payload based on flags; delegate through adapter | 7 Responses, 5 Messages, 6 Chat Completions, 3 Gemini corrections |
| Request/action orchestration | Pivot action, short-circuit, call downstream for tool turns | Compact, collaboration namespace and hosted-tool shims |
| Bidirectional adaptation | Correlate outbound rewrite with returned source adaptation | Chat DeepSeek usage and reasoning-content dialect |
| Result transformation/observation | Filter events, rewrite errors, detect stream failures | Thinking display, thought filtering, whitespace guards |
| Provider adaptation | Apply selected provider's wire rules at its existing boundary | Copilot item-ID membrane and provider request interceptors |

Layers follow current control flow. Responses wraps cross-protocol traversal inside its source chain; Messages/Chat cross-target requests bypass their native source registry and enter the selected target chain; Gemini always cleans its source payload before hub traversal. Consequently, request-only functions remain at their existing positions. A single global normalization pass would not preserve those semantics.

Streaming and hosted-tool work can continue after an attempt returns its lazy result. Request normalization gains no producer, cancellation or settlement authority. Existing source-domain checks, JSON/event adapters, provider retries and turn completion stay with their current owners.

## Deliverables

| Deliverable | Status |
| --- | --- |
| Source/reference responsibility and ordering audit | Complete |
| Synchronous transform adapter and gateway contract | Complete in `c1acacea`; independent spec/quality review approved |
| Migration of 21 corrections with behavior/order coverage | Complete in `4b8afdad`; independent spec/quality review approved |
| Independent review, frozen CI and local integration | Complete: 5,631 pass / 1 skip / 0 fail; whole-branch approval; local `vNext` source fast-forwarded to `4b8afdad` |

See the [qualification record](qualification.md) for the exact artifact, gate results, protected-file checks and local integration. The [whole-branch review](whole-branch-review.md) records the independent merge assessment. Every implementation and integration step is checked in the linked plan.

## Costs and evidence boundaries

Adapters are constructed at module initialization. Each entry adds a synchronous transform call while returning the downstream promise directly on success. No request view allocation, deep clone, stream wrapper, per-frame work or metadata registry is added by this boundary. Whole-service latency, CPU and memory effects have not been measured in this slice.

The existing uncommitted collaboration overlay is part of the tested workspace and remains separate from these commits. Raw reports, logs and preservation manifests live under `.worktrees/cfw-resource-rollback-fix/.superpowers/sdd/2026-10-01-interceptor-contracts/` relative to the main checkout; `.superpowers/` paths in copied reports are relative to the isolated checkout.

## Follow-up architecture decisions

- Prioritize hosted-tool private-state lifetime and capacity. [Focused follow-up](private-state-followup.md) confirms same-response multi-turn search replay, but does not establish normal cross-request replay as a requirement. The global Map lacks count/byte admission and completion cleanup; idle TTL entries need not be removed. Use the complete lazy hosted-tool response as the ownership candidate, verify replay compatibility first, and avoid clearing state at each provider fetch or early event-result return.
- Give call-local translation state one explicit owner while preserving independent native JSON and event adapters.
- Define typed settlement projection inputs and explicit failure/order policy on current facts and receipts.
- Verify the intended Gemini count-tokens normalization contract: an existing registry comment claims cleanup that the inspected count-tokens call path does not perform. This is a source/documentation discrepancy, not yet proof of an incorrect result.
- Trace Messages hosted-search cancellation end to end before treating the absent local signal forwarding as a demonstrated defect.

Exact-artifact workerd resource measurements, diagnostic publication admission and catalog/affinity mixed-version rollback remain release gates. No push, deployment or service restart belongs to this slice.
