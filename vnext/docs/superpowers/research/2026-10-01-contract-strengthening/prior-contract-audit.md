# Prior request-stage and interceptor contract audit

Date: 2026-10-01. Supplied source baseline: `dbde0567`, in `.worktrees/cfw-resource-rollback-fix`.

This is a source-only audit of the completed request-stage and synchronous-interceptor slices. No source or Git changes, tests, benchmarks, installation, process changes, remote access, push, or deployment were performed. Only this audit document was written. Existing test source was inspected; its assertions are not fresh passing-test evidence. Private-payload storage and the translated-event producer-domain alignment are outside this audit.

## Conclusion

The completed slices enforce their central promises: preparation does not call the attempt, the ready capability captures the original runner and can be consumed only once, and `beforeRequest` gives a synchronous transform no downstream/result parameter while delegating once on success. Do not replace these mechanisms with a new workflow framework or runtime sandbox.

Two bounded follow-ups improve the earlier contracts:

1. Make the Responses preparation observer explicitly synchronous and read-only. Its current `void` return admits asynchronous callbacks whose completion and rejection are ignored.
2. Express the gateway's required preprocessing output in its hook/dependency/ready types. The generic kit currently permits omission of preprocessing even when an endpoint declares required routing output, leaving the gateway dependency to reject that omission dynamically.

These are concrete unsafe constructions admitted by today's API, not claims that an existing production caller currently misuses either contract. The original stage spec deliberately allowed optional preprocessing and borrowed references; strengthening those contracts is a follow-up, not proof that the completed work violated its accepted spec.

All paths and line references below are relative to this worktree.

## What is enforced today

| Boundary | Enforced contract | Remaining convention / scope |
| --- | --- | --- |
| Prepare -> execute | `prepareTemplate` does parse, preprocessing, stream choice, telemetry and quota, then creates a capability without inference (`vnext/packages/chat-flow-kit/src/serve-template.ts:247-335`). | Hook implementations remain trusted internal code; the kit cannot prevent a hook from importing arbitrary I/O. No sandbox is warranted. |
| Execution capability | Module-private symbol prevents normal structural construction (`serve-template.ts:193-210`); `pendingRunner` is cleared synchronously before invoking the original bound runner (`serve-template.ts:220-244,325`). Concurrent or post-failure reentry cannot start a second attempt. | Borrowed payload/auth/input identities are retained. Readonly properties do not freeze referents. This is explicit in `vnext/docs/superpowers/specs/2026-10-01-reference-led-stage-contracts.md:45-56`. |
| Lifecycle owner | Generic serve owns prepare/execute/respond/finalize and exception cleanup (`serve-template.ts:54-69,337-353`). Responses prepares/executes inside the existing turn callback (`vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts:252-295`). | A caller of the lower-level prepare API must execute or abandon through its existing owner; the capability is not a durable job. A new global registry or independent cleanup owner would conflict with the intended design. |
| Cancellation | Kit linking is installed only when execution begins, preserves abort reasons and uses the supplied controller (`serve-template.ts:212-235,320-334`). Responses owns its outer unlinking (`responses/serve.ts:244-267`). | This audit did not measure reachability or CPU/heap effects. |
| Endpoint side inputs | Responses, Messages, Chat and Gemini use named input types, respectively at `responses/serve.ts:119-131`, `messages/serve.ts:58-69`, `chat-completions/serve.ts:59-70`, and `gemini/serve.ts:60-71`. | The typed inputs carry live request-local references. Headers and resolver methods retain their native operations. They are not immutable snapshots. |
| RequestTransform | `(req: Req) => undefined` rejects normal async and `void` callbacks by type (`vnext/packages/service/src/request-transform.ts:3-7`); the adapter calls the transform once and `next()` once, preserves the exact downstream promise, and turns synchronous throws into rejected promises (`request-transform.ts:8-15`). | Scheduling detached work inside a synchronous callback is still possible; compile-time contracts are not a security boundary. The spec explicitly chose no runtime result inspection (`vnext/docs/superpowers/specs/2026-10-01-interceptor-contracts.md:44-46`). |
| Normalizer authority | The callback receives only the typed payload/flags view (`vnext/packages/gateway/src/data-plane/chat-flow/shared/request-normalization.ts:5-11`); flags are a `ReadonlySet` (`vnext/packages/protocols-llm/src/common/invocation.ts:10-24`). Payload replacement reaches the original invocation. | The runtime value is intentionally the original invocation. Casts/reflection can recover hidden fields; that is outside trusted-TypeScript authority guarantees. Preserve this identity mechanism. |

The inspected regression assertions cover deferred/concurrent/rejected execution and reference identity (`vnext/packages/chat-flow-kit/src/serve-template.test.ts:59-170`), transform failure/reentry/promise identity (`vnext/packages/service/src/__tests__/request-transform.test.ts:18-26,30-153`), and actual gateway payload replacement (`vnext/packages/gateway/tests/data-plane/chat-flow/shared/request-normalization.test.ts:192-202`).

## Recommendation 1: synchronous preparation observer

Priority: implement in this bounded contract-strengthening slice.

### Evidence and unsafe construction

`ResponsesServeArgs.onPrepared` is `(payload: Record<string, unknown>, compactTriggered: boolean) => void` (`vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts:75-78`). Preprocessing calls it synchronously, ignores its return, then resolves routing and creates affinity (`responses/serve.ts:181-190`). The only production callback found is synchronous: it captures canonical source JSON and may throw `ResponsesSessionError(413, "local_state_limit", ...)` for warmup (`vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts:191-205`). Its failure is part of the preparation decision, not optional background observation.

The following callback is assignable to the current `void` signature under TypeScript's callback rules:

```ts
onPrepared: async (payload) => {
  await checkLocalState(payload)
  throw new Error("local state rejected")
}
```

The caller at `responses/serve.ts:184` neither awaits nor handles that promise. Preparation proceeds into routing and can reach validation/inference while the rejected promise is detached. This is the exact category of mistake already excluded from `RequestTransform` by its `undefined` return type. This construction was reasoned from the source/type definitions, not executed during the audit.

The callback can also currently change top-level routing/transport input without a cast:

```ts
onPrepared(payload) {
  payload.model = "replacement-model"
  payload.stream = true
}
```

`startResponsesTurn` has already computed `common.wantsStream` from the inbound raw value (`responses/serve.ts:256-258`), whereas kit preparation computes stream choice after preprocessing (`serve-template.ts:303`). A mutating observer can therefore create inconsistent stream intent. No existing callback was found doing this. The API should nevertheless say whether it observes or transforms; its actual caller only observes and performs admission checks.

### Smallest coherent change

- Introduce a named synchronous preparation-observer type with return `undefined`, used by `ResponsesServeArgs` and thus its `ResponsesInputs` pick.
- Expose `Readonly<Record<string, unknown>>` for the observer's payload, documenting that it is a borrowed observation view before model routing. This catches accidental top-level writes without copying/freezing the payload. Do not claim deep immutability or a runtime security boundary.
- Keep the invocation in the same place and preserve synchronous throw handling. Do not make the hook async and do not move warmup/local-state admission after execution.
- Keep the existing `session.ts` callback synchronous; it requires no behavioral change. If useful, mark the read-only `create` input of `ResponsesLocalContinuation.candidate` accordingly (`vnext/packages/gateway/src/data-plane/chat-flow/responses/local-continuation.ts:20-24`). No local-store semantics need change.

Migration scope: `responses/serve.ts`, its session observer call site, and focused type/behavior coverage. Suggested later acceptance checks: async callbacks rejected at compile time; top-level observer writes rejected; a synchronous observer throw starts no attempt; existing warmup/state-limit and continuation tests remain unchanged. Avoid suppression directives for type assertions; existing `Assert<...>` patterns in `request-transform.test.ts:18-26` provide the model.

## Recommendation 2: required gateway preparation output

Priority: useful bounded follow-up; implement if the slice includes earlier ready-input contracts. Do not label it a current production authorization bypass.

### Evidence and unsafe construction

The generic `ServeTemplateHooks.preProcess` is optional irrespective of `TExtra` (`vnext/packages/chat-flow-kit/src/serve-template.ts:129-159`). The attempt, response context and telemetry input unconditionally use `TExtra | undefined` (`serve-template.ts:103-118,167-175`). Ready/executed results also retain that possibility (`serve-template.ts:195-210`). This is honest for optional kit preprocessing and matches the accepted stage spec (`vnext/docs/superpowers/specs/2026-10-01-reference-led-stage-contracts.md:56`).

However, every native gateway hook requires preprocessing for routed/incoming model identity and possibly affinity/pinning:

- Responses: `responses/serve.ts:149-191`.
- Messages: `messages/serve.ts:90-97`.
- Chat Completions: `chat-completions/serve.ts:88-95`.
- Gemini: `gemini/serve.ts:89-105`.

The shared gateway dependency still declares default `unknown` payload/extra types (`vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts:71`), then reads `incomingModel` from `unknown` through a record cast and runtime checks (`kit-deps.ts:31-39,74-76`). Gemini separately throws if `a.extra` is absent (`gemini/serve.ts:115-117`); the other endpoints use optional chaining for data actually created on every successful preparation (`responses/serve.ts:221-230`, `messages/serve.ts:102-116`, `chat-completions/serve.ts:100-108`).

Today, an internal author can construct this hook set without a type error:

```ts
const hooks: ServeTemplateHooks<
  Payload, AttemptResult, { readonly incomingModel: string }, Auth, Telemetry
> = {
  endpointTag: "responses",
  parse,
  wantsStream,
  runAttempt,
  respond,
  // No preProcess, despite the declared required preparation data.
}
```

With `kitDeps`, the omission fails only in `buildTelemetryCtx`, outside the preparation error renderer, before quota (`serve-template.ts:305-318`). This fails closed before inference, but the required stage was not made mandatory by its type. With a different dependency that does not inspect `extra`, the kit can issue readiness with no such data. That behavior is valid for generic optional preprocessing, but cannot express the stronger guarantee required by these gateway hooks.

### Smallest coherent change

Require an explicit `preProcess` stage in `ServeTemplateHooks`, with an explicit no-op implementation for callers that need no preparation. This is smaller than a conditional generic or overloaded hook family because all four production consumers already supply the stage:

- `preProcess` is required and its continue result contains the concrete prepared extra.
- After a continue result, telemetry, attempt and ready/executed response context carry that concrete extra, not an unconditional `| undefined`.
- Parse/preprocess failure and short-circuit result metadata can still honestly be undefined where it has not been produced.
- Generic consumers needing no work return `{ kind: "continue", payload, extra: undefined }`; their `TExtra` is `undefined` (or already includes it), so the output type remains honest. A tiny helper can share this construction if repeated; it is not a second stage framework.

Remove the optional-preprocessor branch from `prepareTemplate` and derive its prepared `extra` directly from the continue result. Make `RunAttemptArgs.extra`, `RespondCtx.extra`, `BuildTelemetryCtxArgs.extra`, `ReadyTemplateResult.extra` and `ExecuteTemplateResult.extra` exactly `TExtra`. Keep `PrepareTemplateResult`'s early response branch and `ServeTemplateResult.extra` as `TExtra | undefined`. This lets the implementation prove its result through ordinary control flow, without `extra as TExtra` or non-null assertions.

Type the gateway dependency's minimum prepared data as `{ readonly incomingModel: string }`, preserving endpoint-specific extra fields. A ready gateway request can then directly read required routing data without optional chaining or a late missing-extra guard. Keep quota, history, requested-model stamping and telemetry ordering unchanged. The four production hooks already meet the new stage requirement; their meaningful changes are direct reads of guaranteed output and the dependency type.

Verified consumer inventory and migration files:

- Four production hook objects: `vnext/packages/gateway/src/data-plane/chat-flow/{responses,messages,chat-completions,gemini}/serve.ts`. All have a `preProcess` method today. Responses uses `prepareTemplate`; the other three use `serveTemplate`.
- Core contract and implementation: `vnext/packages/chat-flow-kit/src/serve-template.ts`.
- Gateway typed dependency: `vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts`.
- Kit fixtures: `vnext/packages/chat-flow-kit/src/serve-template.test.ts:46-56` (`defaultHooks` currently omits preprocessing); its specialized typed hooks at lines 127, 414 and 453 already specify it.
- Two additional direct test constructions: `vnext/packages/gateway/tests/dump-accumulator.test.ts:500` and `vnext/packages/gateway/tests/dump-exception-ownership.sqlite.test.ts:102`. Add explicit no-op preparation only; preserve cleanup semantics.
- One saved research script calls the API: `vnext/docs/superpowers/research/2026-10-01-request-stage-contracts/retention-probe.ts:47`. This is not a production consumer; decide whether to keep its historical evidence immutable or adapt a new probe separately. It is not a reason to add compatibility overloads to production code.

No provider registrations, registries, protocol translation, database schema or retry policy needs modification. Compared with a conditional generic/overload solution, the required-stage design trades a tiny explicit no-op in test/generic callers for a single easy-to-read hook contract and exact prepared output. Given the verified call sites, prefer the required-stage design.

Suggested later acceptance checks: a hook lacking preprocessing is rejected by type; ready context exposes exact extra; explicit no-op preprocessing exposes `undefined`; short-circuits cannot execute; original identity, quota/error ordering and single-use execution tests retain their behavior. Update the earlier spec to state the now-required explicit stage rather than retroactively claiming its former optional mode was broken. This is a source-level API tightening, with no change required to any existing production preprocessing body.

## Boundaries not selected for this slice

- **Do not restore complete inbound protocol validation.** The parsers intentionally preserve vendor extensions (`vnext/packages/gateway/src/data-plane/parsers.ts:4-30,68-97`) and tests intentionally allow Messages without model/max_tokens (`vnext/packages/gateway/tests/data-plane/parsers.test.ts:61-63`). These parser return types overstate the shape of forwarded input, and invalid model values can reach `parseModelRouting`'s string operation (`vnext/packages/gateway/src/data-plane/routing/model-routing.ts:6-11`). Honest raw-object versus routing-ready types and minimal model validation merit a separate behavior-specified change; they must not sneak full protocol schemas back into this contract slice.
- **Do not deep-freeze shared auth/input graphs.** The kit's comment that preprocessing cannot alter auth means it cannot return replacement auth through `PreProcessResult`; generic `TAuth` does not prove transitive immutability (`serve-template.ts:87-101`). Native routing policy objects also have mutable fields (`vnext/packages/gateway/src/shared/api-key-model-mappings.ts:1-9`). Current native hooks only read auth and return routing output. Strengthening selected readonly type views can be incremental; cloning/freezing all auth, headers, payloads or enabled flags would exceed the demonstrated need and alter the borrowed-reference contract.
- **Do not add post-consumption finalization to the capability.** The existing serve/Responses owners already govern streams, diagnostics and continuation. A second owner would make failure/abandonment authority less clear.
- **Do not add runtime Promise detection to RequestTransform.** Its type, existing adapter behavior and explicit trusted-code scope align. Retain registry order, normalization placement and orchestration reentry.
- **Do not expand this audit into typed settlement, translator-trip or private storage work.** Those are distinct increments already identified in the stage/interceptor specs. No new performance or deployment-readiness claim follows from these type improvements.
