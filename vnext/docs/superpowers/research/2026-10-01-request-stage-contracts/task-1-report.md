# Task 1 implementation report

Status: DONE. Source commit: `9b387b4c6c7e6944504dc6e282e3324663b46ed2`.
Base: `2212683b7c536baf96c8b636a3ec01338b030bc3` with the protected collaboration overlay.

## Changed files

- `vnext/packages/chat-flow-kit/src/serve-template.ts`
- `vnext/packages/chat-flow-kit/src/serve-template.test.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/serve.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/gemini/serve.ts`

The source commit contains exactly these six files. No protected overlay file or documentation was staged. Existing protocol serve tests were sufficient for this migration; their expected behavior was not rewritten.

## RED and GREEN evidence

Before implementation, the new contract test called the existing `prepareTemplate`, recorded attempt/respond calls, and expected no calls plus `kind: ready`. `bun test packages/chat-flow-kit/src/serve-template.test.ts` from `vnext/` returned **27 pass / 1 fail**. The failure showed actual `["attempt"]` against expected `[]`; it was a behavior failure, not an import or setup error.

After implementation and updated stage assertions, the kit suite passed **36 tests / 0 failures / 115 assertions**. Added coverage proves preparation starts neither attempt nor response, pending and successful duplicate executions cannot restart inference, rejected execution retains the exact rejection object and remains consumed, the original runner and method receiver are preserved, and prepared payload/auth/extra/telemetry/side-input/dump/controller references plus request timestamp survive the handoff. Cancellation coverage includes no listener during preparation, supplied controller reuse, already-aborted and between-stage reasons, and links remaining effective after the attempt returns. Both attempt and respond failure cleanup remain covered.

## Validation commands and results

All commands below ran from the isolated `vnext/` directory unless stated otherwise.

```sh
bun test packages/chat-flow-kit/src/serve-template.test.ts packages/gateway/tests/data-plane/chat-flow/responses/serve.test.ts packages/gateway/tests/data-plane/chat-flow/messages/serve.test.ts packages/gateway/tests/data-plane/chat-flow/chat-completions/serve.test.ts packages/gateway/tests/data-plane/chat-flow/gemini/serve.test.ts packages/gateway/tests/data-plane/chat-flow/responses/turn-barrier.test.ts packages/gateway/tests/dump-exception-ownership.sqlite.test.ts
```

Result: **86 pass / 0 fail / 306 assertions**, across seven files. This includes cancellation before Responses preparation, compact/history behavior, terminal/continuation barriers, and real SQLite dump exception ownership.

```sh
bun test packages/gateway/tests/data-plane/chat-flow/responses/session.sqlite.test.ts packages/gateway/tests/data-plane/responses-upgrade-fallback.test.ts
```

Result: **50 pass / 0 fail / 165 assertions**, across two files. Warmup makes zero inference calls, generation follows real warmup state, quota/revocation/connection admission remain unchanged, and transport fallback coverage passes.

```sh
bun run --filter '@vibe-core/chat-flow-kit' typecheck
bun run --filter '@vibe-llm/gateway' typecheck
bun run scripts/check-framework-purity.ts
bunx eslint packages/chat-flow-kit/src/serve-template.ts packages/chat-flow-kit/src/serve-template.test.ts packages/gateway/src/data-plane/chat-flow/responses/serve.ts packages/gateway/src/data-plane/chat-flow/messages/serve.ts packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts packages/gateway/src/data-plane/chat-flow/gemini/serve.ts
```

Result: all exit **0**; purity reports **OK**. ESLint emitted only the existing multiple-project configuration advisory. An intermediate test timestamp assertion failed typecheck because it was possibly undefined; an explicit guard fixed it. An intermediate receiver-identity test triggered `no-this-alias`; asserting the receiver inside the runner fixed it. The final kit suite, kit typecheck, and scoped lint were rerun successfully after these fixes. `git diff --cached --check` passed before commit.

The SHA-256 check against `isolated-protected-files.json` reports **14 checked / 0 changed**. Full `ci:local`, independent review, and final local integration belong to the root controller and are not claimed here. No benchmark or deployment ran.

## Self-review and concerns

The module-private symbol exposes only the `executeTemplate(ready)` consumption path. The helper captures prepared arguments, response context, inbound signal, and the original runner bound to its existing hooks receiver; it does not capture raw input or preparation dependencies. Runner consumption occurs synchronously before abort linking, runner invocation, or any await. No retry, replacement runner, registry, deep copy, early abort response, or per-frame work was introduced.

Parse/preprocess/telemetry/quota ordering and requested-model stamping remain in preparation. Generic serve remains the diagnostic exception owner and composes prepare/execute/respond/finalize. Responses prepares and executes inside the existing deferred turn callback; its turn still owns transport, upstream cancellation, completion, and dump finalization. Warmup validation, prepared callbacks, local continuation, compact stream override, inbound headers, and existing endpoint response envelopes remain unchanged. Side-input dictionary casts were replaced by named typed inputs on all four hooks, and optional preprocessing is now represented honestly by `RespondCtx.extra: TExtra | undefined`.

No unresolved implementation concern was found. Prepared state is borrowed by reference under the caller immutability contract; this change does not freeze payloads or make resource/performance improvement claims.

## Fix round 1: independent review retention finding

The independent review found an Important/P2 request-payload retention regression in the nested abort listener despite the functional suite passing. This supersedes the initial self-review's no-concern assessment. Fix commit: `717cd86e3a64af063c3f59c1a721c3aa31cf5b35` (`fix(vnext): isolate execution abort listener lifetime`). It changes only `vnext/packages/chat-flow-kit/src/serve-template.ts`.

Read `.superpowers/sdd/2026-10-01-request-stage-contracts/task-1-review.md` and reran its exact companion probe from the worktree root before the fix:

```sh
bun .superpowers/sdd/2026-10-01-request-stage-contracts/task-1-retention-probe.ts
```

RED observation: in Node v26.0.0, base `afterServeAlive=false`, head `afterServeAlive=true`; head becomes false after abort. Bun 1.3.0 base/head both remain alive before abort, while the no-signal head control releases in both runtimes. This reproduces the listener lifetime dependency with real source transpilation, not source-text assertions.

The narrow correction creates the listener in a module-local `linkInboundAbort(signal, controller)` helper whose only request-specific parameters are the cancellation signal and controller. The branch is unchanged: supplied self-controller is skipped, an already-aborted reason is forwarded, and the listener remains registered with `{ once: true }` during response delivery. The capability still synchronously consumes its runner before linking; no new cancellation policy, listener removal at attempt return, global state, WeakRef, or GC mechanism was added to production.

GREEN: rerunning the same probe now reports head `afterServeAlive=false` and `afterAbortAlive=false` in **both Node v26.0.0 and Bun 1.3.0**. The historical Bun base remains true before abort, as expected; the no-signal control remains false. This is a focused local reachability result, not a workerd/production measurement or retained-byte estimate.

Post-fix validation from `vnext/`:

```sh
bun test packages/chat-flow-kit/src/serve-template.test.ts packages/gateway/tests/data-plane/chat-flow/responses/turn-barrier.test.ts packages/gateway/tests/dump-exception-ownership.sqlite.test.ts
bun run --filter '@vibe-core/chat-flow-kit' typecheck
bunx eslint packages/chat-flow-kit/src/serve-template.ts
```

Results: **79 pass / 0 fail / 289 assertions** across three test files; typecheck and lint exit 0. The existing post-attempt cancellation, original reason, supplied-controller, cancellation-before-preparation, and diagnostic ownership contracts pass unchanged. Scoped `git diff --check` passed, and the protected-overlay SHA-256 comparison again returned **14 checked / 0 changed**. Root documentation remained unstaged. Root owns the final independent re-review and full `ci:local` for the combined artifact.
