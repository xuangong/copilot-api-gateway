# Reference-led request stage contracts

## Intent and evidence

Make business stages understandable through their contracts, then refine layering around actual ownership and execution. The user's direction is to actively adopt the reference project's strengths and treat contracts as essential. This continues the authorized architecture work and local vNext integration; it does not authorize deployment.

Evidence baseline: local reference `1d7dcd923e260e425120cca0c7a240e93720af27` and vNext `8451196284a6c5f501f8b7e00a376bbd3009848f` with the preserved collaboration overlay. Reference paths below are relative to `/Volumes/Projects/copilot-gateway`. These are source comparisons, not performance measurements or claims about the latest remote revision.

## Reference strengths and adoption decisions

| Reference mechanism | Concrete benefit | vNext adoption |
| --- | --- | --- |
| `packages/gateway/src/data-plane/chat/openai-responses/serve-prep.ts`: discriminated `OpenAIResponsesServePlan`, consumed by `serve.ts` | Preparation visibly ends before inference. Failure and readiness are distinct outcomes. Generate and compact share preparation without hiding execution. | Implement a real preparation/execution boundary in `chat-flow-kit` and migrate all four native serve paths. A ready plan belongs to one request and one execution. |
| `packages/gateway/src/data-plane/shared/gateway-ctx.ts` and `chat/shared/gateway-ctx.ts`: typed request context, attempt state and background scheduler | Dependencies and lifetime ownership are visible at the call site instead of being implicit dictionary conventions. | Type the endpoint inputs carried through kit hooks. Keep existing scoped executors and Responses turn ownership; a large universal context is unnecessary. |
| `packages/translate/src/types.ts` and `chat/shared/translate-traverse.ts`: one conversion trip owns request, event and error mappings | Conversion-private state is local to the protocol pair; the returned event domain is explicit. | Preserve the existing producer-domain and native JSON contracts. A future call-local translator trip can group state without forcing JSON through SSE. |
| `chat/openai-responses/client-output.ts`: named output stages | Readers can see output reconstruction, affinity, state publication and resource completion in business order. | Use named responsibilities inside the existing turn owner as those responsibilities change. Keep the successful-continuation barrier and transport cleanup authority. |
| `data-plane/shared/telemetry/settle.ts`: one settlement entry | Call sites consistently attribute usage and performance to a terminal call. | Build any later settlement adapter on current facts/receipts/completion. The reference function has fixed sinks and separate writes, not an extensible transaction. |
| Provider-owned wire shaping and typed provider results | Vendor knowledge remains with the provider and gateway attempts are easier to read. | Keep the already implemented provider registrations and per-call adapters. A later explicit decode/adapt boundary can clarify attempts while preserving byte-level provider responses. |

The reference still uses ordered interceptor arrays and shared mutable invocation state. It does not provide enforced, independently pluggable business stages. Our extension contracts must describe caller intent, per-attempt state, stream transformations and failure policy explicitly.

## Layering derived from the real process

| Responsibility | Input / output contract | Owner and extension boundary |
| --- | --- | --- |
| Admission at the transport edge | HTTP/WS request -> authenticated request context | Existing route/auth policy owns admission. Existing HTTP and WS policy differences are preserved. |
| Input preparation | Raw payload + typed endpoint inputs -> protocol payload and preparation state, or protocol-shaped response | Protocol hooks own history hydration, compaction expansion and model mapping. Preparation may do state I/O, but never starts inference. |
| Quota and execution readiness | Prepared payload + auth -> ready execution capability, or quota response | Existing kit order remains parse -> preprocess -> stream choice -> telemetry -> quota. This batch does not relocate routing or affinity authority. |
| Routing and execution | Ready capability -> existing attempt result | Native attempt owns descriptor selection/materialization, provider preparation and dispatch. Tool loops and allowed retry remain inside this phase. |
| Adaptation and delivery | Explicit producer domain + body/events -> client JSON/SSE/WS output | Current adapters/renderers consume one source; execution and delivery overlap for streams. Provider wire fixes stay inside the selected attempt. |
| Completion and projections | Validated terminal state -> continuation publication, execution facts, projection receipts and compatibility completion | Responses turn stays the single owner. Mandatory continuation commit precedes successful terminal delivery. Optional projections do not become a second execution owner. |

These are responsibilities, not a requirement for six packages or six asynchronous queues. Stages can contain several synchronous functions. Extension authors must know the accepted input, guaranteed output, allowed mutation, lifetime, failure outcome and work/resource ownership.

## Selected implementation slice

### Preparation and single-use execution

`prepareTemplate` returns either the existing `{ kind: "response", response, extra }` short circuit or `{ kind: "ready", context, extra, ...executionCapability }`. It must not call `runAttempt` or `respond`.

`executeTemplate(ready)` is the only public consumer of the execution capability. It receives no replacement hooks, auth, inputs or dependencies. The capability captures the prepared attempt inputs and original runner. A module-private symbol prevents casual construction of a ready result outside its owner. Mark consumption synchronously before invoking the runner; duplicate calls reject even when the first call is still pending or has failed. No global registry, deep payload copy or replay cache is needed.

The result of execution carries the existing attempt result and prepared response context. `serveTemplate` composes prepare, execute, respond and dump finalization. `startResponsesTurn` composes prepare and execute inside its existing deferred producer callback and hands the outcome to the existing turn owner. Warmup still calls validation, compact still chooses JSON, and native JSON/SSE adaptation stays unchanged.

Ready capabilities are immediate request-local handoffs, not durable plans. The consumer must execute or abandon the request through its existing lifecycle owner. The capability does not finalize diagnostics, schedule background work, persist continuation or own transport completion. Kit-created abort links are installed at execution, not on a potentially abandoned ready plan. Caller-owned controllers are reused; already-aborted and between-stage cancellation reasons reach the runner unchanged, preserving current endpoint handling rather than introducing a new abort response policy.

### Typed endpoint inputs

Add a defaulted `TInputs` generic to `ServeTemplateInput`, `PreProcessCtx`, `RunAttemptArgs`, `RespondCtx`, `ServeTemplateHooks` and preparation/execution result types. The existing `extras` property carries `TInputs`; its name can remain to avoid unrelated churn. The four native endpoints explicitly supply:

- Responses: continuation resolver, history-retention choice, warmup, prepared callback, request identity, action and upstream cancellation callback.
- Messages: inbound headers.
- Gemini: requested model and forced stream choice.
- Chat Completions: no endpoint side inputs.

Remove side-input casts from these hooks. Preserve input object identity and auth references across the handoff. These are borrowed request-local references: callers must not mutate them between preparation and execution; a readonly container is not a deep-freeze guarantee. The kit remains domain-neutral. Optional preprocessing means response context must honestly allow `extra` to be undefined; do not disguise this with an assertion.

### Compatibility and resource constraints

- Preserve parse/preprocess/quota error precedence and protocol error envelopes.
- Preserve request start time, requested-model stamping, auth authority and telemetry attribution.
- Keep exceptional diagnostic cleanup at the existing owner, preserving the original exception; do not move cleanup to each phase.
- A kit-owned abort listener captures only its signal/controller cancellation state. Create it outside the ready capability's lexical scope so a retained inbound signal cannot keep prepared payload/auth/telemetry alive through that scope.
- Preserve single-consumer streaming, native JSON, producer-domain checks, eligible affinity candidates and provider materialization policy.
- Introduce no schema, deployment, storage semantics or retry-policy changes.
- Reuse `.worktrees/cfw-resource-rollback-fix` and installed dependencies. Preserve unrelated worktree bytes and existing processes.
- The capability adds a small per-request closure/state and an explicit asynchronous handoff. It does not clone payloads or add per-frame work. CPU/latency/heap effects require later exact-artifact measurement; this change makes no performance-win claim.

## Alternatives considered

1. Rename the existing preparation function to acknowledge execution: accurate naming but leaves the stage contract missing.
2. Adopt typed preparation and a single-use execution capability: selected because it resolves the demonstrated boundary problem with the current owners.
3. Introduce a generalized stage registry/workflow runtime: adds lifecycle and allocation costs before this application has demonstrated a need.

## Acceptance

- A prepared ready result has invoked neither attempt nor response; executing it invokes the original attempt exactly once.
- Concurrent, successful-then-repeated and rejected-then-repeated consumption cannot start another attempt.
- Short circuits never produce an executable capability and retain original responses and extra state.
- Stage handoff preserves prepared payload, auth, telemetry, endpoint inputs, timestamp and cancellation identity/reason.
- Preparation alone attaches no kit-owned inbound abort listener; execution preserves existing linking behavior.
- A retained inbound signal does not retain the completed prepared request through the kit's own abort-listener closure. Qualify this with a focused reachability probe as well as cancellation behavior tests; do not infer whole-isolate memory limits from it.
- Both generic serve and Responses turn use the new boundary, including warmup and compact behavior.
- Existing source/stream/continuation and exceptional dump cleanup suites pass; affected package typechecks and final local CI pass before integration.

## Later architecture increments

These remain distinct follow-ups, not claims that this slice has completed them:

- Classify extension contracts for request normalization, tool orchestration, provider wire adaptation and event observation. First identify actual mutation and ordering dependencies, then choose narrower callable interfaces.
- Group protocol-pair private state into call-local translation trips while retaining separate JSON and event adapters.
- Give settlement projections a typed input and explicit failure/order policy using current execution facts and receipts. Preserve current behavior unless a policy change is separately specified.
- Keep diagnostic publication admission, catalog/affinity rollback qualification and exact-artifact CFW CPU/heap measurements on the existing operational follow-up list.
