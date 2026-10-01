# Hosted Search Execution Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Complete and independently review each task before marking it done.

**Goal:** Own eager hosted-search work from pure preparation through cancellation and real settlement, and close the diagnostic snapshot cancellation window.

**Architecture:** Tools own search execution and cache lifetime. Existing protocol owners adopt narrow cancellation/settlement capabilities; output/completion stay at their existing layers. Diagnostic route cancellation is bound before its initial read.

**Tech Stack:** Strict TypeScript, Bun, existing provider fixtures, SQLite and Workers dry-run.

**Spec:** [Execution and cancellation contracts](../specs/2026-10-01-hosted-search-execution-contracts.md).

## Global Constraints

- Work in `.worktrees/cfw-resource-rollback-fix` using existing dependencies. No push, deployment, service restart, dependency installation, production access or benchmark.
- Preserve the original 38 main and 14 isolated protected files byte-for-byte and never stage them. Keep the existing Bun fixture alive. Retain this worktree and raw evidence.
- Preserve native JSON, search fanout and ordering, page batching, replay arguments and IDs, tool-loop reentry, existing iteration/turn limits, normal fallback/retry, usage finalization, diagnostic storage ordering, and continuation/completion owners.
- No arbitrary numeric capacity default, deep clone/freeze policy, database migration, retry policy change or environment variable.
- Follow strict TypeScript: no `any`, suppression directives or new non-null assertions. Source/docs English; user communication Chinese.
- Focused validation during development; one final complete CI on frozen source. Report source mechanisms separately from measured CPU/memory/latency gains.

### Task 1: Implement search execution scope and cancellation boundaries

**Files:** Create `vnext/packages/gateway/src/data-plane/tools/web-search/execution-scope.ts` and matching `tests/data-plane/tools/web-search/execution-scope.test.ts`. Modify `plan-operations.ts`, `operations.ts`, `key-config.ts`, `providers/jina.ts`, `providers/microsoft-grounding.ts` in that source directory. Extend existing plan-operations, key-config, providers tests. Keep Alpha direct API compatible; test existing Alpha route coverage after low-level changes.

**Interfaces:** Produce `createWebSearchExecutionScope(session: Omit<WebSearchExecutionSession, "pageCache">): WebSearchExecutionScope`. Scope methods: `prepare(args: Record<string, unknown> | null): PreparedWebSearchBatch`, `assertOpen(): void`, `cancel(): undefined`, `settled(): Promise<void>`. Prepared batch exposes readonly `plans` and single-use `start(): StartedWebSearchBatch`; started batch exposes readonly `calls` with readonly `plan` and `result(): Promise<WebSearchCallIR>`. Implementation may use module-private tracker types shared with operations; no chat-flow dependency.

- [x] Write discriminating RED cases for fallback after swallowed abort, late cache writes, cancelled delayed provider resolution, and pure prepare/single start. Scope tests may initially fail on the missing export; preserve the real old-code fallback failure separately.

```ts
const scope = createWebSearchExecutionScope(sessionConfig)
const prepared = scope.prepare({ search_query: [{ q: "a" }, { q: "b" }] })
expect(providerStarts).toEqual([])
const batch = prepared.start()
expect(() => prepared.start()).toThrow()
scope.cancel()
await expect(batch.calls[0]?.result()).rejects.toBeDefined()
```

- [x] Implement a local controller/cache owner with immediate observation of every eager branch. Track each complete provider-plus-usage leaf, not only parent aggregates. Dispose completed registrations; retain no cumulative task log. Cancellation revokes waiting delivery without waiting for noncooperative providers; real settlement still observes every started leaf.
- [x] Reuse pure split and current start scheduling. Link parent abort once, handle already-aborted, prohibit prepare/start after close, preserve normal page deduplication/cache reuse. Observe synchronous factory throws. No clones, serial queue, cap or hidden normal timeout.
- [x] Add pre/post provider-resolution, provider/usage and cache-write guards; stop fallback on signal state or recognized abort, while preserving ordinary errors/empty fallback. Check the existing Jina/MS retry boundary before starting each attempt without changing policy.
- [x] Verify all-started sibling and usage settlement with deferred fixtures, unconsumed rejected result observation, normal fanout/order/arguments, repeated close, late successes and parent-listener cleanup. Run focused suites, gateway typecheck, purity, scoped lint and protected hashes. Keep the old `planWebSearchCalls` only as a temporary adapter for Task 2; document this staged migration. Commit only task source/tests and write the implementation report with RED/GREEN evidence.

### Task 2: Bind both hosted callers to owned execution

**Files:** Modify `vnext/packages/gateway/src/data-plane/orchestrator/server-tools/types.ts`, `data-plane/chat-flow/responses/interceptors/server-tool-lifetime.ts`, `server-tool-shim.ts`, `server-tools/web-search.ts`, `data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.ts`, and shared planner. Create a narrowly scoped Chat lifecycle helper beside its interceptor if needed. Extend `tests/data-plane/chat-flow/responses/interceptors/server-tool-private-lifecycle.test.ts`, actual web-search fanout/lifetime coverage, and Chat shim tests. Add source-included contract assertions if public capability shape needs them. Do not edit protected attempt/registry overlays.

**Interfaces:** Consume Task 1 scope. Add `ServerToolHostedWork` with `cancel(): undefined; settled(): Promise<void>` and optional `ServerToolHostedDispatch.work`. Add `ServerToolLifetime.ownWork(work: ServerToolHostedWork): void` which adopts synchronously and cancels synchronously on close, then uses existing cleanup settlement policy. The slot lifetime view remains unable to cancel the invocation. Protocol terminal and writer interfaces stay unchanged.

- [x] Write RED tests using the actual search registration: discard after eager dispatch but before slot acquisition cancels provider signal, late results cannot write/reenter, and an unconsumed rejected branch stays observed. Add preparation rejection/invalid request after an earlier work owner was returned.

```ts
const pending = iterator.next()
await providerStarted
const closing = result.discardProducer?.()
expect(providerSignal.aborted).toBe(true)
providerDeferred.resolve(success)
await closing
await pending.catch(() => undefined)
expect(nextRunCount).toBe(0)
expect(privateWrites).toEqual([])
```

- [x] Adopt hosted work immediately on registration, before later preparation and first upstream run. Release every adopted owner on all early returns and exceptions. `ownWork` closes all work synchronously even if one cancel callback throws, and observes actual settlement asynchronously. Cleanup timeout stays explicit incomplete cleanup and never changes a previously decided outcome.
- [x] Migrate Responses to one active hosted scope, pure preparation and metadata construction before single start; slots await result access. Preserve replay-only/native inactivity, existing iteration refusal, fanout IDs, failed/incomplete materialization while live, private replay and metadata ordering. Remove the old unowned planner export after both callers migrate.
- [x] Migrate Chat with a concrete lazy-result owner, explicit pre-pull/pending-read return/throw/discard behavior, current-producer disposal and late-run-result disposal. Reuse shared producer/cleanup primitives; no wholesale lifetime-engine rewrite. No reentry, message mutation or terminal success after close. Close on normal drain and failures as well as abandonment.
- [x] Exercise both protocol lifetimes (normal drain, native JSON through existing adapters, before-first-pull return/discard, pending search abort, later upstream result, current producer cleanup), plus unchanged fanout/replay/citations/usage/client-tool handoff/budgets. Run only focused suites, types, purity, scoped lint and protection hashes. Report exact commands/results and commit scoped source/tests.

### Task 3: Bind diagnostic cancellation before the snapshot

**Files:** Modify `vnext/packages/gateway/src/control-plane/dump/routes.ts`; extend `vnext/packages/gateway/tests/control-plane-dump.test.ts` or add a focused sibling `control-plane-dump-lifetime.test.ts` using the real channel broker. Preserve existing authorization/SQLite tests.

**Interfaces:** No public signature or wire event changes. The existing AbortController owns the eager subscription; raw-request abort is attached before subscription/snapshot work and removed on all exits.

- [x] Add a RED route test with a pending snapshot read, publish into the real broker, abort the request, and assert subscriber cancellation before resolving the read. Add authorized already-aborted and read-failure cases.

```ts
const request = new Request(url, { signal: controller.signal })
const pendingResponse = app.fetch(request)
await snapshotStarted
controller.abort()
expect(subscriptionSignal.aborted).toBe(true)
resolveSnapshot([])
const response = await pendingResponse
expect(await response.text()).not.toContain("event: snapshot")
```

- [x] Move signal ownership before eager registration, handle already-aborted after authorization, suppress SSE delivery after a read settles late, and observe read rejection. Preserve subscribe-before-snapshot for live clients and existing non-aborted failure behavior. No claim that pending SQL is cancelled; no queue dropping policy.
- [x] Verify snapshot then queued appended delivery for a live client, abort before/during/after snapshot, read reject with/without abort, repeated cleanup, listener removal, and existing auth behavior. Run focused route/broker/SQLite auth suites, gateway types, purity, scoped lint, protection hashes. Commit source/tests and record RED/GREEN evidence.

## Qualification and integration

- [x] Independent task specification/quality reviews and fix loops, marking every task complete after its review.
- [x] Whole-increment review, triage deferred issues and archive contract matrix/follow-up decisions.
- [x] Freeze a fresh non-doc source/config/test manifest including the protected overlay; run one complete `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local`.
- [x] Verify unchanged frozen source and original hashes; fast-forward local vNext and compare both source manifests, protected inventories and fixture identity.
- [x] Commit scoped qualification/closeout docs and report local outcome, no push/deploy and remaining capacity/workerd/rollback gates.
