# Request Boundary Contract Strengthening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Check each item only after implementation, review and supporting evidence exist.

**Goal:** Strengthen prior stage/producer contracts and give hosted-tool private state explicit ownership and release rules.

**Architecture:** Required preparation produces exact typed data; synchronous observers cannot silently detach work. Producer types match runtime support. Typed reader/writer capabilities and an owned-versus-borrowed private-state dependency fit inside the existing lazy hosted-response owner.

**Tech Stack:** Strict TypeScript, Bun, existing gateway/core packages and local Workers dry-run.

**Spec:** [Contract strengthening](../specs/2026-10-01-contract-strengthening.md).

## Global Constraints

- Work in `.worktrees/cfw-resource-rollback-fix` with existing dependencies. No push, deployment, service restart, dependency installation or production access.
- Preserve the original 38 main and 14 isolated protected files byte-for-byte; do not stage them. In particular, keep Responses attempt and registry overlays unchanged.
- Preserve parse/history/quota precedence, wire payload rules, tool-loop reentry, native JSON, producer checks, Responses continuation barriers and cleanup ownership.
- Keep core packages domain-neutral. No `any`, suppression directives, new non-null assertions, schemas, flags, environment variables or retry changes.
- Source/docs English; user progress Chinese. Keep changes scoped and review each task independently.
- Focused checks during implementation; freeze final source plus overlay and run one full `ci:local` after integration of all task changes. No benchmarks in this slice and no performance-gain claims.

## Task 1: Exact preparation output and synchronous observation

**Files:**
- Modify `vnext/packages/chat-flow-kit/src/serve-template.ts` and `serve-template.test.ts`.
- Modify `vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts` and the four `{responses,messages,chat-completions,gemini}/serve.ts` modules.
- Add type assertions under `vnext/packages/gateway/src/data-plane/chat-flow/responses/serve-contracts.test.ts` so normal gateway typecheck includes them. Use existing Responses serve/session tests for behavioral coverage; add focused assertions there when missing.
- Adapt only explicit hook fixtures in `vnext/packages/gateway/tests/dump-accumulator.test.ts` and `dump-exception-ownership.sqlite.test.ts`.
- `responses/session.ts` and `local-continuation.ts` may receive a readonly observation input annotation if required by the named observer; no behavior change.

**Interfaces:**
- `ServeTemplateHooks.preProcess` is required, retaining its existing promise-returning shape and `PreProcessResult` union.
- `RunAttemptArgs.extra`, `RespondCtx.extra`, `BuildTelemetryCtxArgs.extra`, `ReadyTemplateResult.extra`, `ExecuteTemplateResult.extra`: `TExtra`.
- Early response and outer result extra remain `TExtra | undefined`.
- Gateway `PreparedModelIdentity = { readonly incomingModel: string }`; `kitDeps` takes that minimum extra type.
- Export `ResponsesPreparedObserver = (payload: Readonly<Record<string, unknown>>, compactTriggered: boolean) => undefined`; use it for `ResponsesServeArgs.onPrepared`.

- [x] **Add type-contract RED assertions.** Use `Assert<T extends true>` aliases without suppression. Check that omitting `preProcess` is not assignable, exact prepared `extra` does not add undefined, explicit `TExtra=undefined` remains valid, and async/broad-void callbacks are not assignable to `ResponsesPreparedObserver`. Check readonly payload via a type equality/writability utility, not an unsafe cast. Run affected typechecks before implementation and record contract failures.
- [x] **Implement the required stage through control flow.** After parse, always await `hooks.preProcess(payload, { auth, extras })` in the existing preparation try/catch; return the existing early envelope on failure/short-circuit. Continue using `pre.payload` and `pre.extra` directly through telemetry, quota, ready and attempt. No `as TExtra` or missing-extra assertion.

```ts
async preProcess(payload) {
  return { kind: "continue", payload, extra: undefined }
}
```

This explicit no-op belongs only in fixtures/generic callers whose declared `TExtra` permits undefined. Give fixtures with a concrete extra an appropriate concrete value; keep their original behavioral assertions honest. Do not add compatibility overloads for the historical retention probe saved under older research.

- [x] **Migrate concrete gateway guarantees.** Type `kitDeps` with `PreparedModelIdentity`, retain the invalid/empty incoming model check, and replace only unjustified optional-extra accesses in the four endpoints. Keep field-level optionality, identity and all preprocessing bodies/order. Apply the named observer without awaiting it; synchronous exceptions retain the existing preparation response behavior.
- [x] **Validate behavioral contracts and compile contracts once together.** Cover observer throw before inference and warmup validation, prepared data identity, early error/no quota/no attempt, explicit no-op, and existing single-use/rejection behavior. Run kit tests, four serve tests, Responses session/warmup tests, turn-barrier and the two dump suites; kit/gateway typechecks, purity, scoped lint. No full CI or benchmark.
- [x] **Self-review and commit.** Verify protected hashes, no changed auth/routing/error policy and no new assertion hiding undefined. Commit `refactor(vnext): enforce prepared request output contracts`; write a detailed task report with commands/results and scope.

## Task 2: Align translated producer and dispatch contracts

**Files:**
- `vnext/packages/protocols-llm/src/common/result.ts` and `common/index.ts`.
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts` and `hub-attempt-dispatch.ts`.
- Create `vnext/packages/protocols-llm/src/common/__tests__/producer-contract.test.ts`; extend current producer runtime tests only for a missing assertion.
- Narrow gateway fixture helper hub arguments in `vnext/packages/gateway/tests/data-plane/chat-flow/shared/producer-domain.test.ts` if the stronger type exposes their broad annotation. Preserve deliberate malformed foreign-input tests.

**Interfaces:**

```ts
export type TranslatedProducerProtocol = Exclude<TranslatorProtocol, "gemini">
// TranslatedLlmEventResult.producer.protocol: TranslatedProducerProtocol
// TraverseTranslationArgs.hubProtocol: TranslatedProducerProtocol
export type HubAttemptProtocol = TranslatedProducerProtocol
```

- [x] **Add compile-time RED coverage.** Assert that the translated producer protocol rejects Gemini and admits each supported hub. Assert native/source Gemini remains valid. Place assertions under `src` included by protocol typecheck and observe failure before narrowing.
- [x] **Implement the shared type and aliases.** Keep `eventProducerProtocol` runtime checks and `TranslatorProtocol`/telemetry semantics intact. Do not change attempts or protected overlays. Preserve body/event adapter independence and producer disposal.
- [x] **Run focused validation.** Protocol common result/contract tests; real producer-domain and cleanup suites; traversal tests; protocol/gateway/provider-copilot typechecks, purity and scoped lint. Existing malformed producer fixtures must still reject at runtime. No full CI.
- [x] **Self-review and commit.** Verify no runtime narrowing mistakenly rejects native Gemini or changes source protocol semantics. Commit `refactor(vnext): align translated producer domain contracts`; write report and protected-hash evidence.

## Task 3: Own private state across the full lazy hosted response

**Files:**
- New `vnext/packages/gateway/src/data-plane/orchestrator/server-tools/private-payload.ts` for the existing v1 schema and foreign replay decoder.
- `.../orchestrator/server-tools/private-payload-store.ts` and `types.ts` for capability/dependency contracts.
- New `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-lifetime.ts` for the owned lazy-result resource lifecycle.
- Existing `.../responses/interceptors/server-tool-shim.ts` and `server-tools/web-search.ts` for capability wiring and slot cleanup.
- Focused new store/decoder/lifetime tests under matching gateway `tests/data-plane/` directories; type assertions under a `src/.../__tests__` file included by gateway typecheck. Extend existing shim/web-search fixtures where they supply real composition.
- The protected `responses/interceptors/index.ts` stays byte-identical.

**Interfaces:** Consume the reader, typed writer, scope, owned source and legacy borrowed dependency signatures exactly as specified in the design. Keep `defaultPrivatePayloadStore`'s name but make its value an owned source. Keep `createInMemoryPrivatePayloadStore` available for explicit legacy injection. Keep the plugin's `WebSearchCallPrivatePayload` type export through re-export. The common terminal's optional private payload uses this named type. The new typed writer and owned disposer return `undefined`, with compile-time assertions rejecting async/broad-void implementations; the legacy borrowed store retains its original `void` signatures and trusted synchronous convention.

- [x] **Characterize existing replay and add lifecycle RED tests.** Use actual search registration for two tool turns with `include` absent; assert complete prior search output reaches both subsequent upstream payloads. Characterize explicit injected-store replay. Add failing independent-default and unstarted return/discard/abort cleanup cases before product edits. A retained reader reference returning no value is observable release; no production test-only size counter is needed.
- [x] **Implement schema and separated capabilities.** Move the current v1 shape without changing wire fields; validate consumed function/action/result fields at the borrowed-store adapter boundary. The plugin reader returns the known payload or undefined; owned typed writes need no repeated deep read validation. Invalid history remains the existing miss. Give plugins a real reader facade, materializer a typed writer, owner a disposer. Skip undefined writes. Owned scope reads return undefined after close; writes reject; disposal is idempotent. Borrowed adapter closure stops local access without clearing external storage. No deep clone/freeze or arbitrary numeric limits.
- [x] **Wire lazy ownership without inactive storage costs.** Prepare plugin context with a stable reader facade, activate owned storage only for hosted work, and retain it across all loop turns. Inactive/default replay-only calls allocate no Map/listener/result wrapper. Every early exit after acquiring ownership disposes it. Returning the first EventResult does not dispose it.
- [x] **Implement explicit lazy-result closure.** The helper synchronously closes state and unlinks abort on normal end, exception, return, throw, abort or discard, including before first pull. Track and close the current slot/producer independently of the outer generator's finally. Use existing bounded cleanup helpers and propagate incomplete cleanup through their existing failure channels. Late slot/provider resolution must not write, dispatch again or emit output; dispose a late returned result. Preserve and settle existing final metadata once, without inventing request completion success.

```ts
// The manual slot owner must close on early consumer return or an error.
const lifecycle = slot.run()
let finished = false
try {
  while (true) {
    const step = await lifecycle.next()
    if (step.done) {
      finished = true
      if (step.value.privatePayload !== undefined) {
        writer.registerPrivatePayload(slot.id, step.value.privatePayload)
      }
      yield* serverToolEndFrames(merge, outputIndex, slot, step.value)
      break
    }
    yield stampServerToolEvent(merge, outputIndex, slot.id, step.value)
  }
} finally {
  if (!finished && !(await closeStream(lifecycle))) lifetime.recordIncompleteCleanup()
}
```

The lifetime helper must expose `recordIncompleteCleanup(): void`, retaining a monotonic cleanup-failure flag. Its composite cleanup promise rejects if any tracked close/disposal fails or times out; subsequent successful outer-generator closure cannot reset that failure. Final metadata settles independently, and a cleanup error must not replace the original wire failure. The concrete implementation must additionally register the slot with the owner before awaiting `next()`, so abort can request close while that await is pending. This is the algorithm, not permission to leave empty blocks.

Independent review additionally requires rejecting sparse foreign `results`, `queries` and `sources` arrays without copying valid payloads. The lifetime must release its closure callback before invocation and avoid storing callbacks registered after closure, so the completed owner does not retain the output merge graph through that callback.

- [x] **Validate complete authority and lifecycle paths.** Assert typed terminal payload, no reader writer/dispose keys, no materializer disposal authority; invalid foreign payload fallback; no undefined registration; distinct concurrent/default invocations; borrowed state survives local close; natural completion and failures; before-first-next return/throw/discard/abort; cancel during slot and later provider await; late completion cannot create a new turn; the current producer/slot is closed. Include existing producer-domain, JSON, turn-barrier and collaboration suites. Run gateway/protocol types, purity and scoped lint. No full CI or benchmark.
- [x] **Self-review and commit.** Verify original public output/activation/search fanout and protected files. Explicitly report unproven quantitative capacity and arbitrary abandoned-reference limitations. Commit `refactor(vnext): scope hosted tool private state ownership`; write complete report.

## Qualification and integration

- [x] Independently review each task for spec compliance and quality; resolve blocking findings before the next task.
- [x] Record the strengthened contract inventory, reference advantages, retained guarantees and remaining capacity/release gates.
- [x] Freeze all non-doc vnext source/config/test files plus the preserved overlay; run one `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` from the isolated vnext.
- [x] Complete whole-branch review. Compare frozen hashes and original protected files, then fast-forward local `vNext` under the standing authorization.
- [x] Commit closeout docs, verify both checkouts agree, preserve the running fixture/worktree/raw evidence, and report exact local-only results.

## Final evidence

Qualified source: `da6cc3693ff1a64ecb5d9670905f0f713d90d099` plus the preserved overlay. One final complete CI passed: **5,677 pass, 1 skip, 0 fail**, 26 package typechecks, purity, lint with 34 unchanged warnings, setup/dashboard builds and Worker dry-run. Both checkouts match the 1,555-file frozen source manifest; original 38 main and 14 isolated hashes match. See the [qualification record](../research/2026-10-01-contract-strengthening/qualification.md) for exact artifact, independent reviews, local integration and outstanding capacity/release gates. No push or deployment.
