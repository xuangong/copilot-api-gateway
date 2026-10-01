# Reference-led request stages: implementation record

Date: 2026-10-01. Baseline: local `vNext` `84511962` plus the preserved collaboration overlay. This batch implements the [request stage plan](../../plans/2026-10-01-request-stage-contracts.md) and [reference adoption design](../../specs/2026-10-01-reference-led-stage-contracts.md).

## Reference strengths adopted

The reference project's discriminated preparation plan makes a useful guarantee: readiness is visible before inference begins. Its typed request and attempt contexts also expose dependencies and their lifetimes. These are the two strengths implemented here, rather than only naming existing functions after stages.

| Reference strength | Implemented vNext contract | Practical benefit |
| --- | --- | --- |
| Typed preparation plan | `prepareTemplate` returns a protocol response or a ready capability without calling attempt/respond | Preparation and execution can be reasoned about separately; an early response cannot accidentally execute |
| Explicit execution input | `executeTemplate` consumes the original bound runner at most once, including pending or failed executions | Stage handoffs cannot substitute another runner or replay the same prepared inference |
| Typed request context | All four protocol adapters declare their side inputs through `TInputs`; preprocessing output remains a separate type | Missing fields and incompatible endpoint inputs become compile-time errors; casts no longer hide these contracts |
| Visible lifetime ownership | Ordinary serve and Responses turn retain cancellation, diagnostics, transport and completion authority | The additional boundary does not split cleanup or continuation responsibility across competing owners |

Reference evidence is the local checkout at `1d7dcd923e260e425120cca0c7a240e93720af27`; precise file mappings are in the design. Its conversion-trip, named output-stage and settlement-entry strengths remain valuable follow-ups, and are not claimed as completed here.

## Layers follow the request's actual responsibilities

Admission -> input preparation -> quota/readiness -> routing/execution -> adaptation/delivery -> completion/projections.

These responsibilities do not require six packages, queues or lifecycle owners. Streaming execution overlaps delivery; allowed tool loops remain inside execution. Each extension must specify input, output, permitted mutation, lifetime, failure result and work/resource ownership. Prepared objects are borrowed references and must not be modified between prepare and execute; the implementation does not deep-copy or deep-freeze them.

Existing native JSON/event paths, producer-domain checks, quota/history error ordering, warmup validation, compact behavior, continuation barriers and HTTP/WS admission policies are preserved. No environment variables or migrations were added.

## Completed implementation and review

- `9b387b4c`: separates preparation and single-use execution; migrates generic serve and Responses turn; types four protocol side-input contracts.
- `717cd86e`: fixes the independent review's Important/P2 abort-listener retention finding by isolating its lexical scope to signal/controller.
- The contract test first failed because preparation invoked the attempt. The implemented kit passes all 36 contract tests.
- Independent final combined review approved the complete slice with no outstanding findings. The source is integrated into local `vNext`; all 1551 qualified file hashes match the main checkout, and all 38 main/14 isolated protected files retain their original bytes.
- Focused protocol/ownership tests and warmup/session/fallback tests passed. Final frozen-artifact CI passed: **5616 pass, 1 existing skip, 0 fail**; purity, workspace typechecks, lint, UI/setup build and Worker dry-run also passed.

The initial implementation passed functional tests but retained the prepared request through an abort-listener closure under local V8. After the fix, the payload is collectible while the inbound signal remains live in both Node v26 and Bun 1.3. This demonstrates why the lifetime contract includes reachability as well as callback behavior. It establishes neither total heap reduction nor CFW capacity. The capability adds per-request closure/state and an asynchronous handoff; its CPU/latency cost has not been measured in this batch.

See [qualification](qualification.md), [implementation report](task-1-report.md), [initial review](task-1-review.md), [approved fix review](task-1-rereview.md), and [final combined review](whole-branch-review.md). Reports preserve their historical statuses; the qualification record owns final acceptance. Raw logs, hash manifests and original scripts remain under `.worktrees/cfw-resource-rollback-fix/.superpowers/sdd/2026-10-01-request-stage-contracts/` relative to the main checkout. `.superpowers/` paths in copied reports are relative to the isolated checkout.

The retained [GC probe](retention-probe.ts) runs from the repository root with:

```sh
bun vnext/docs/superpowers/research/2026-10-01-request-stage-contracts/retention-probe.ts
```

It compares historical base source, current source and a no-signal control using explicit local GC. Read the boolean output: exit zero alone is not a retention assertion. At the qualified source, both runtimes report `head.afterServeAlive=false`; the historical Bun base reports true. The script needs the baseline Git object and local Bun/Node; it does not access production or change source.

## Next architecture increments

1. Classify interceptor contracts by actual role: request normalization, tool orchestration, provider wire adaptation and event observation. Record current mutation and ordering dependencies before narrowing interfaces.
2. Group protocol-pair private state into call-local conversion trips, borrowing the reference's request/event/error cohesion while preserving separate native JSON and event paths.
3. Define typed settlement projection inputs and explicit failure/order policy on existing execution facts and receipts; continuation durability and compatibility completion retain their current owners.

The existing operational gates still apply: diagnostic publication concurrency admission, exact-artifact local workerd CPU/latency/heap comparison, and catalog/affinity mixed-version rollback qualification with backups. This batch does not deploy or establish release readiness.
