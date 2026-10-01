# Request boundary contract strengthening

## Intent and baseline

Strengthen enforced contracts, including the already completed request stages, normalization and producer domains. Baseline is local `vNext` `dbde0567b505267098258fa3293b38ca29d3b27a` with its preserved collaboration overlay. The user explicitly authorized continued architecture implementation and local integration. No remote release belongs to this work.

The current/reference audits are retained in `.superpowers/sdd/2026-10-01-contract-strengthening/`. Reference HEAD is `1d7dcd923e260e425120cca0c7a240e93720af27`. Borrow its explicit source-owned private scratchpad and typed dependencies; preserve this gateway's native JSON, lazy output, existing source/producer domains and completion owners.

## Contract inventory and decisions

| Boundary | Enforced guarantee after this batch | Owner and failure policy |
| --- | --- | --- |
| Preparation | An explicit preprocessing stage returns payload plus exact `TExtra`, or a response | Existing parse/preprocess envelopes and quota ordering remain; early responses may have no extra |
| Ready execution | Ready/attempt/response/telemetry contexts carry the exact prepared extra; execution remains single-use | Existing private capability binds the original runner; no replacement inputs or second execution |
| Preparation observer | Named callback returns `undefined` and sees a readonly top-level payload | Synchronous throw rejects preparation before inference; async callbacks are rejected by TypeScript |
| Request correction | Existing synchronous payload/flags contract, original Invocation and one delegation per entry | Retain all 21 adapters, positions and around-interceptor reentry; no further runtime sandbox |
| Translated producer | The declared hub domain is exactly Chat Completions, Messages or Responses | Existing runtime guard still rejects malformed foreign values; Gemini remains a supported source/native protocol |
| Tool private state | Explicit owned source versus borrowed store; plugin reader, materializer writer, invocation disposer | Default state lasts through one complete lazy hosted response; injected external storage is never cleared |
| Completion and projections | Existing facts, receipts and continuation barrier remain authoritative | No new settlement or transport owner is introduced |

These are trusted implementation contracts, not deep immutability or runtime security isolation. No stage framework, metadata registry, auth-policy change or full request-schema validation is required.

## Required preprocessing and synchronous observation

Make `ServeTemplateHooks.preProcess` required. All four production hooks already provide it; generic callers that need no work explicitly return `{ kind: "continue", payload, extra: undefined }` and use `TExtra = undefined`. This is simpler than conditional generic families or overloads.

After the continue branch, `RunAttemptArgs.extra`, `RespondCtx.extra`, `BuildTelemetryCtxArgs.extra`, `ReadyTemplateResult.extra` and `ExecuteTemplateResult.extra` are exactly `TExtra`. The early `response` branch and outer `ServeTemplateResult` retain `TExtra | undefined`. Derive the prepared value from ordinary control flow; no assertion that an optional value exists is allowed.

The gateway dependency declares its minimum preparation output as a named `PreparedModelIdentity` with `readonly incomingModel: string`. Each endpoint's existing extra satisfies it. Preserve the empty/invalid incoming-model runtime check, while removing the `unknown` record lookup. Remove optional access or missing-extra guards only where successful preparation now guarantees the value. Optional fields inside that value remain optional.

Name `ResponsesPreparedObserver = (payload: Readonly<Record<string, unknown>>, compactTriggered: boolean) => undefined`. Keep its call at the existing pre-routing point and keep the current synchronous session admission callback. This prevents accidental async callbacks and top-level assignment through the declared observation view without payload copies. Existing warmup/local-state errors must still stop the attempt.

## Producer type/runtime alignment

Export `TranslatedProducerProtocol = Exclude<TranslatorProtocol, "gemini">` from the protocols common surface. Use it for `TranslatedLlmEventResult.producer.protocol` and `TraverseTranslationArgs.hubProtocol`; make gateway `HubAttemptProtocol` an alias of it. Keep the runtime validation, independent body/event adapters, telemetry types and producer cleanup unchanged. The type change does not forbid native Gemini or a Gemini source. Existing malformed-producer tests remain deliberate runtime-boundary fixtures.

## Private-state authority and lifetime

Replace the default module-wide Map with an explicit owned source, retaining the existing `defaultPrivatePayloadStore` export name so the protected registry remains byte-identical. The shim accepts either that source or the existing `PrivatePayloadStore` as a borrowed dependency. The legacy explicitly injected TTL implementation remains available and retains its own replay/expiry semantics.

Use distinct capabilities:

```ts
interface ServerToolPrivatePayloadReader {
  getPrivatePayload(itemId: string): WebSearchCallPrivatePayload | undefined
}
interface ServerToolPrivatePayloadWriter {
  registerPrivatePayload(itemId: string, payload: WebSearchCallPrivatePayload): void
}
interface OwnedServerToolPrivatePayloadScope {
  readonly reader: ServerToolPrivatePayloadReader
  readonly writer: ServerToolPrivatePayloadWriter
  dispose(): void
}
interface OwnedServerToolPrivatePayloadSource {
  readonly ownership: "owned"
  createScope(): OwnedServerToolPrivatePayloadScope
}
type ServerToolPrivatePayloadDependency = OwnedServerToolPrivatePayloadSource | PrivatePayloadStore
```

The legacy borrowed store retains its unknown-valued read contract. Its invocation adapter validates those foreign values before exposing the typed reader; owned typed writes do not need repeated deep validation on every read. Give plugins a real reader-only facade; materialization receives only the typed writer. Only the outer shim/result owner retains disposal authority. A closed invocation returns no private values and rejects writes; disposing is idempotent. Borrowed stores are not cleared or disposed, but that invocation stops accessing them after closure.

Move the current web-search v1 payload shape into a small gateway-owned contract module and keep the plugin's existing type export as a re-export. `ServerToolTerminal.privatePayload` becomes that named optional payload. Strengthen the foreign-value decoder for the currently consumed action/result/function-call fields; invalid/unknown-version history remains a miss. Preserve the current shape and public output. Skip `undefined` registrations. Do not store image base64 or add a persisted replay format.

The admitted values remain borrowed references under trusted-code mutation rules; do not deep-clone or freeze entire search results merely to enforce a stronger claim than this slice requires. Avoid increasing retained copies on CFW. The reader facade limits operations, not arbitrary mutation via unsafe casts; record that boundary explicitly.

Owned state is created at most once for an active outer hosted response, never per provider fetch, turn or frame. Inactive/default replay-only preparation needs no Map, listener or result wrapper. It survives the initial lazy result return and every subsequent input rewrite. No TTL eviction or write-time global sweep applies to live owned state. Default invocations share no replay values; explicit borrowed injection retains existing direct shared-store replay. Do not seed from wire results, native snapshots or unused repository tables.

Use a small owned-lifetime helper to close private state synchronously and idempotently on drain, error, return, throw, abort and `discardProducer`, including before first iteration. Unlink any added abort listener at closure. Track the currently owned producer rather than retaining only the first result's discard callback. A late result must be disposed and must not resume registration, another upstream turn or output after closure. Bound asynchronous iterator/body cleanup using existing helpers; do not turn cleanup timeout into a false success.

The materializer manually drives a slot iterator today. Add closing `finally` and track the active slot so cancellation can request closure even while `next()` is pending. Returning an unstarted outer generator must still release state and settle the existing final metadata. Preserve metadata identity, native JSON adapters, source cancellation and terminal failure behavior. Do not introduce a second request outcome or continuation owner.

Capacity admission is explicitly separate: this slice does not claim count/byte bounds or complete request memory bounds. Numeric defaults, preflight search-work limits and an explicit overflow response need representative resource evidence. Do not silently evict active replay data or invent arbitrary limits here.

## Global constraints

- Work in `.worktrees/cfw-resource-rollback-fix` with existing dependencies. No push, deployment, service restart, dependency installation or production access.
- Preserve the original 38 main and 14 isolated protected files byte-for-byte; do not stage them. In particular, keep Responses attempt and registry overlays unchanged.
- Preserve parse/history/quota precedence, wire payload rules, tool-loop reentry, native JSON, producer checks, Responses continuation barriers and cleanup ownership.
- Keep core packages domain-neutral. No `any`, suppression directives, new non-null assertions, schemas, flags, environment variables or retry changes.
- Source/docs English; user progress Chinese. Keep changes scoped and review each task independently.
- Focused checks during implementation; freeze final source plus overlay and run one full `ci:local` after integration of all task changes. No benchmarks in this slice and no performance-gain claims.

## Acceptance and evidence

Type-level checks must be included by the normal package tsconfigs: missing preprocessing, async/void observer and unsupported translated producer construction are rejected; concrete prepared extra and readonly observer input are accepted with their precise types. Runtime tests retain early-response ordering, exact handoff identities, single-use execution and synchronous observer rejection.

Private-state tests cover same-response multi-turn replay; independent default invocations; borrowed replay preservation; undefined omission; inactive allocation; malformed foreign data; natural and exceptional closure; unstarted return/discard/abort; pending-slot and late-provider cleanup; and no next turn or terminal output after closure. Exercise real hosted-search registration in representative translated source fixtures, along with existing native activation, producer, JSON and continuation regressions. Use explicit small fixture values without claiming production resource measurements.

Before local fast-forward, independent review and complete CI must pass. Compare the exact frozen source set and protected files in both checkouts; retain existing running fixtures and evidence. Report remaining capacity, workerd measurement, diagnostic admission and catalog/affinity rollback gates separately.
