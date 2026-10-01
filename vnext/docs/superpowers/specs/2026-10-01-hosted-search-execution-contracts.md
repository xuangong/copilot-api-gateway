# Hosted Search Execution and Request Cancellation Contracts

Date: 2026-10-01. Continues the authorized local vNext architecture work.

## Problem and selected direction

The shared search planner currently starts provider work before callers acquire slot iterators. The Responses lifetime can close without cancelling those eager tasks. Chat immediately observes top-level promises but lacks an owner for abandoned search work and later upstream producers. Fallback treats cancellation as ordinary failure, and late page results can mutate the cache. Separately, the diagnostic SSE route binds raw-request cancellation only after its snapshot query.

Retain the reference project's explicit phases and narrow owner capabilities. Reuse the existing pure split logic, introduce an invocation-owned execution scope, and bind it to the two actual hosted result lifetimes. Keep current fanout and protocol semantics. No numeric capacity policy is selected: current source establishes cancellation obligations, not safe workload sizes.

Alternatives considered: adding only signal guards leaves explicit return/discard and eager settlement unowned; adding operation quotas requires representative policy evidence; moving all protocol lifetimes into a generic engine expands the change beyond the concrete search boundary. The selected scope plus caller adapters addresses actual ownership without these unrelated decisions.

## Global constraints

- Work in `.worktrees/cfw-resource-rollback-fix` using existing dependencies. No push, deployment, service restart, dependency installation, production access or benchmark.
- Preserve the original 38 main and 14 isolated protected files byte-for-byte and never stage them. Keep the existing Bun fixture alive. Retain this worktree and raw evidence.
- Preserve native JSON, search fanout and ordering, page batching, replay arguments and IDs, tool-loop reentry, existing iteration/turn limits, normal fallback/retry, usage finalization, diagnostic storage ordering, and continuation/completion owners.
- No arbitrary numeric capacity default, deep clone/freeze policy, database migration, retry policy change or environment variable.
- Follow strict TypeScript: no `any`, suppression directives or new non-null assertions. Source/docs English; user communication Chinese.
- Focused validation during development; one final complete CI on frozen source. Report source mechanisms separately from measured CPU/memory/latency gains.

## Search phases and capabilities

1. **Prepare:** use the existing `splitWebSearchCalls` rules. No provider or usage work starts. A prepared batch is bound to its execution owner and can start once. No global token registry, clone or freeze. This is not capacity admission; expansion is still unbounded.
2. **Start:** require an open owner. Launch all existing plan/page branches with their current scheduling semantics. Every promise has immediate success/rejection observation, even when its result is never requested. Synchronous factory exceptions become observed failure, never successful empty IR.
3. **Resolve and execute:** check cancellation before and after provider resolution and immediately before invoking a provider. Own each complete search/page usage wrapper individually, including its awaited usage `finally`; owning only fail-fast `Promise.all` aggregates does not cover siblings.
4. **Deliver:** result access propagates the original failure or IR while open and stops promptly on close. Check cancellation after provider/usage settlement, before mapping/cache writes and before protocol delivery/reentry. A late success cannot repopulate a retired cache.
5. **Retire:** synchronous idempotent cancel first closes admission/delivery, aborts only the local signal, clears owned page cache, rejects waiting deliveries and removes the downstream listener. Settlement remains pending until all actually started tracked work settles. Remove settled registrations; do not accumulate task history.

The public owner has `prepare(args)`, `assertOpen()`, `cancel()` and `settled()` capabilities. `prepare(args)` returns `{ plans, start() }`; `start()` returns `{ calls }`, where each call exposes its plan and `result(): Promise<WebSearchCallIR>`. Exact exported names: `createWebSearchExecutionScope`, `WebSearchExecutionScope`, `PreparedWebSearchBatch`, `StartedWebSearchBatch`. Creation accepts the existing session configuration excluding `pageCache`; it takes exclusive ownership of a new cache and links the existing optional signal. Repeated start throws without executing more work. After close, even preparation rejects before expansion. `settled()` is the real post-cancel settlement receipt, not a deadline.

Keep existing `WebSearchExecutionSession` and Alpha direct operation entrypoints compatible. A narrow optional internal provider-work tracker may flow through low-level operations; owned start always supplies it. The public unowned `planWebSearchCalls` path must disappear when both hosted callers migrate. Shared tools must not import concrete chat-flow lifetime classes.

## Provider cancellation

Guard fallback before each engine, after its await and in the catch branch. Inspect signal state as well as recognized abort exceptions: built-in adapters may return ordinary error envelopes on abort, and abort reasons can be custom values. Ordinary exception/error/empty outcomes retain fallback while live. A recognized abort exception must not cause fallback even when no signal is supplied.

Jina/Microsoft retry helpers check cancellation immediately before every attempt, retaining existing delay/count/conditions. Do not broadly rewrite provider result types. Not-started operations create no usage entry; already-started operations retain usage finalization. Signal guards prevent local starts and acceptance of late results; they cannot certify cancellation of remote work or detached tasks inside an injected provider.

## Responses owner integration

Add an optional hosted `work` capability `{ cancel(): void; settled(): Promise<void> }`. The registration creates a search scope only for an active hosted tool, never inactive/native/replay-only requests. The host adopts that capability as soon as registration returns, before further preparation or upstream execution. Every invalid-request, later-registration throw and preparation failure closes already adopted work.

Keep `ServerToolLifetime` as the outer resource owner and `materializeServerToolItems` as the output/private writer. Extend its resource adoption to synchronously cancel work during close and then observe real settlement using the existing stream cleanup wait policy. One failing cancellation callback must not prevent others from being closed. Existing private store, source producer and final metadata owners remain in place. A cleanup timeout reports incomplete cleanup; it must not resolve the scope's actual settlement or emit a new terminal response.

The web-search dispatcher prepares slots and canonical arguments before eager start. Slot generators await owned result access. Preserve normal dispatched-work materialization on upstream failed/incomplete frames while the invocation is open. Closing via return/throw/discard/abort, including before first pull, cancels eager work even when no slot iterator was acquired. Internal failure must not abort the external downstream controller or be relabeled as client cancellation.

## Chat Completions owner integration

Create the same search scope only after active engine resolution. A small Chat-specific lazy-result wrapper owns the scope, current upstream producer, and pending upstream factory results. Explicit next/return/throw/discard work before first pull and during a pending read; generator finally alone is insufficient. Reuse shared producer disposal and bounded cleanup primitives, without relocating the whole Responses lifetime or copying its entire state machine.

Normal drain/error/return/throw/abort/discard closes the scope and current producer once. An upstream result arriving after close is disposed and never consumed. Guard before first/next `run`, after batch wait and after next-result acquisition. Do not append tool messages, reenter or emit success after closure. Preserve lazy/native producer validation, citations, summed usage, client-tool handoff, four search turns plus final answer, and one concatenated tool message per original function call. Existing Chat attempt/translation code remains the error and native JSON owner.

## Diagnostic snapshot cancellation

Bind raw-request abort before subscribing and reading the snapshot. After authorization, an already-aborted request starts neither subscription nor snapshot. For live requests preserve subscribe-before-snapshot so notifications during the read remain queued. Abort during the read cancels the subscription immediately, and late read settlement does not begin SSE delivery. SQL lacks a cancellation port: let the already-started read settle and observe its rejection. Remove the listener on all exits; preserve existing live event names, failure behavior, authentication and persisted data.

Do not introduce queue shedding or wake-up/reload replacement. Latest-page snapshots plus the current completedAt/id cursor cannot guarantee complete notification recovery. That needs a separate durable visibility and client reconciliation design.

## Qualification and limits

Use deferred providers and actual broker behavior for cancellation/late results; use real SQLite where persistence is exercised. Test pure prepare/single start, normal concurrent fanout, delayed provider resolution, unconsumed rejection, sibling/usage settlement, swallowed abort fallback, retry attempts, both actual hosted caller lifetimes and the diagnostic snapshot window. Preserve existing protocol and Alpha tests. No module-wide mocks.

A noncooperative provider or repository can remain pending after the existing bounded cleanup wait. Keep its rejection observed and forbid late delivery/cache mutation, but do not claim it was stopped. This increment adds no operation/body/replay/page-cache/queue capacity bound and reports no measured CFW resource gain. Those policies, local workerd comparison, catalog/affinity rollback and release backup/restore qualification remain follow-ups.
