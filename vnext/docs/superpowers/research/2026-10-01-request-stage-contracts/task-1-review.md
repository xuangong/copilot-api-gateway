# Task 1 independent specification and quality review

Reviewed artifact: `2212683b7c536baf96c8b636a3ec01338b030bc3..9b387b4c6c7e6944504dc6e282e3324663b46ed2`.
The supplied review package was the authoritative change scope. Only the kit implementation and the named Responses ownership/cleanup risk received additional source inspection. No source or Git state was changed by this review.

## Verdict

**Needs fixes: one Important / P2 resource-lifetime regression.** The requested preparation/execution contract is otherwise implemented correctly. Full CI and final integration remain the root controller's responsibility.

## Ranked findings

### 1. Important / P2: isolate the inbound abort listener from the execution capability's request graph

Location: `vnext/packages/chat-flow-kit/src/serve-template.ts:226-229`, especially line 229.

The new listener is nested inside the async execution capability. Its use of `signal` reaches the outer `createReadyTemplate` environment, which also holds prepared `args` and `context`. Clearing `pendingRunner` prevents duplicate inference but does not release that environment. On a successful generic serve whose inbound signal stays reachable without aborting, the listener keeps the completed request payload reachable even after the ready/executed values and serve result have been discarded. Larger payloads can therefore remain live for the signal's remaining lifetime, including streaming response delivery or other callers that retain/reuse the inbound signal.

This is demonstrated locally, not merely inferred from closure syntax. A WeakRef probe executes the actual base/head source after TypeScript-only transpilation, uses stateless hooks, drops the serve result, keeps only the inbound controller/signal and a weak reference to the payload, and performs ten event-loop-separated full GCs. The no-signal control and abort control distinguish listener retention from the test harness retaining the payload.

| Runtime / source | Payload alive after serve, signal not aborted | Payload alive after abort |
| --- | --- | --- |
| Node v26.0.0 / V8, base | false | false |
| Node v26.0.0 / V8, head | **true** | false |
| Node v26.0.0 / V8, head with extracted link helper (in-memory experiment) | false | false |
| Node v26.0.0 / V8, head without inbound signal | false | false |
| Bun 1.3.0, base | true | false |
| Bun 1.3.0, head | true | false |
| Bun 1.3.0, head with extracted link helper (in-memory experiment) | false | false |
| Bun 1.3.0, head without inbound signal | false | false |

The former implementation already exhibits analogous retention under this Bun version, but the base/head contrast demonstrates a new retention regression under the local V8 runtime. This is not a measured workerd/production leak or an estimate of aggregate retained bytes. It requires the inbound signal to remain reachable; once the signal/listener becomes unreachable or the once-listener fires, the payload can be collected. Responses supplies its own controller and the same signal, so its `signal !== controller.signal` guard avoids installing this particular listener.

**Required correction:** install the link from a module-local function whose only request-specific parameters are `controller` and `signal`. Invoke it when execution begins, preserving the existing same-signal guard, already-aborted reason propagation, and `{ once: true }` behavior. Do not remove the link when the attempt resolves: SSE cancellation must remain effective during response delivery. The in-memory helper experiment preserved the existing branch verbatim and eliminated the observed retained payload in both tested runtimes.

Reproduction from the worktree root:

```sh
bun .superpowers/sdd/2026-10-01-request-stage-contracts/task-1-retention-probe.ts
```

The companion script compares base with the current working-tree head and a no-signal control. After the correction, both runtimes should report `head.afterServeAlive: false`; the historical Bun base result may remain `true`. It uses no source mutation, production service, benchmark, or additional test dependency.

## Contract and quality strengths

- Preparation performs parsing, requested-model stamping, preprocessing/history expansion, telemetry construction, and quota gating before producing readiness. It starts neither attempt nor response and installs no inbound abort link.
- The non-exported symbol provides the typed execution capability. `executeTemplate` accepts no replacement hooks. `hooks.runAttempt.bind(hooks)` captures the original function and receiver, and the runner is synchronously consumed before linking or calling it. Pending, successful, and rejected repeat executions are covered; rejection identity is preserved.
- The final defaulted `TInputs` parameter is threaded through input, preprocessing, attempt, response context, hooks, preparation, and execution. All four serve adapters declare named side-input types, remove the relevant dictionary-value casts, and keep no-input Chat Completions explicit. `RespondCtx.extra` accurately allows `undefined`.
- Generic serve composes prepare/execute/respond inside the original diagnostic exception owner. Attempt and respond failure tests retain the original error even when cleanup throws or rejects. Canonical completion/finalization logic is unchanged.
- Responses still prepares and executes inside the existing deferred turn callback. Existing turn cancellation, response ownership, history retention, completion/snapshot ownership, and dump finalization remain in that owner. Warmup still selects validation, compact still forces JSON, and `onPrepared`, local continuation, and inbound-header behavior remain unchanged.
- The changed tests exercise real identity and lifecycle contracts rather than just mirroring helper implementation. The module-private symbol is an API capability/nominal type boundary, not a security boundary against JavaScript reflection; no stronger guarantee is needed by this task.

## Validation and limits

Independently rerun:

```sh
cd vnext
bun test packages/chat-flow-kit/src/serve-template.test.ts
```

Result: **36 passed, 0 failed, 115 assertions**. The focused GC matrix above also completed successfully as a diagnostic experiment and exposed the finding despite those functional tests passing.

The implementation report supplies the RED result, endpoint/turn-barrier/SQLite ownership and warmup/fallback results, typechecks, purity, lint, and protected-overlay checks. Those are implementation-reported evidence, not independently rerun here. Full CI was deliberately deferred. The inherited ESLint multiple-project advisory is not a new runtime defect or review finding.

No second blocking finding was identified in the scoped changes.
