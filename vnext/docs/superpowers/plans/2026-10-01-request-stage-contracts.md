# Request Stage Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement and review this contract slice. Check off deliverables only after their evidence exists.

**Goal:** Adopt the reference project's preparation-plan and typed-context strengths in the current vNext request pipeline.

**Architecture:** Separate preparation from single-use execution using a request-local capability. Keep ordinary serve and Responses turn as lifecycle owners, and carry endpoint side inputs through typed hook contracts. Refine business layers around existing runtime behavior.

**Tech Stack:** Strict TypeScript, Bun, existing Hono and platform adapters.

**Spec:** [Reference-led stage contracts](../specs/2026-10-01-reference-led-stage-contracts.md).

## Global Constraints

- No push, CFW deployment, Docker replacement, service restart, dependency installation or production access. Integrate reviewed commits into local `vNext` under existing authorization.
- Work only in `.worktrees/cfw-resource-rollback-fix`; preserve all existing tracked and untracked overlay bytes. Do not stage pre-existing changes.
- Keep native JSON, producer-domain checks, streaming backpressure, Responses continuation barriers, auth and quota/history error order unchanged.
- Keep the kit domain-neutral. No `any`, suppression directives or new non-null assertions; English source/docs and Chinese progress.
- Do not add global plan registries, deep payload copies, per-frame work, generic workflow engines or new lifecycle owners.
- Preparation may perform existing state I/O but cannot infer. A ready capability is request-local and consumed at most once.
- Focused contract tests during implementation; one final full CI qualification of the frozen artifact. Report resource costs without asserting unmeasured gains.

## Task 1: Real preparation and typed single-use execution

**Files:**
- Modify `vnext/packages/chat-flow-kit/src/serve-template.ts` and its existing `serve-template.test.ts`.
- Modify `vnext/packages/gateway/src/data-plane/chat-flow/{responses,messages,chat-completions,gemini}/serve.ts`.
- Update the corresponding `vnext/packages/gateway/tests/data-plane/chat-flow/*/serve.test.ts` only where actual integration assertions are needed.
- Run existing `responses/turn-barrier.test.ts`, `tests/dump-exception-ownership.sqlite.test.ts`, and applicable WebSocket/warmup tests without rewriting their expected semantics.

**Interfaces:**
- `PrepareTemplateResult<Payload, AttemptResult, Extra, Telemetry, Inputs>` keeps the response branch and changes the executed-attempt branch to a `ready` branch.
- Export `executeTemplate(ready)` that consumes a module-private execution capability and returns `{ result, context, extra }`. Bind the original runner when creating the capability; never accept replacement hooks at execution.
- Thread a final defaulted `TInputs = Record<string, unknown>` generic through the kit input/hook/context types. Endpoint hooks use explicit named side-input types; a no-input endpoint can use `Record<string, never>`.
- `RespondCtx.extra` is `TExtra | undefined`, consistent with optional preprocessing.
- Existing serve exports and transport results remain unchanged.

- [x] **Write and run the failing contract test before implementation.** Extend the existing fixture so merely preparing does not invoke the attempt:

```ts
const calls: string[] = []
const prepared = await prepareTemplate(defaultHooks({
  runAttempt: async a => {
    calls.push("attempt")
    return { kind: "ok", echoed: a.payload.value }
  },
}), defaultInput(), defaultDeps())
expect(calls).toEqual([])
expect(prepared.kind).toBe("ready")
```

Run from `vnext`: `bun test packages/chat-flow-kit/src/serve-template.test.ts`. Record the expected failure, not a missing-import error.

- [x] **Implement the boundary.** After the existing quota check, assemble the context and prepared attempt arguments without calling the runner. Create the ready capability in a helper that captures only required prepared state, avoiding retention of raw input/dependency objects. At first execution, synchronously clear/consume its runner before calling it; repeat consumption throws a clear invariant error. Install an inbound abort link only when execution begins. Preserve already-aborted reason propagation and supplied-controller reuse. No new early-abort policy.

```ts
const prepared = await prepareTemplate(hooks, input, deps)
if (prepared.kind === "response") {
  // Keep the existing response/finalization path.
} else {
  const executed = await executeTemplate(prepared)
  // Ordinary serve responds here; Responses hands this to its turn owner.
}
```

- [x] **Add lifecycle and identity assertions.** Use a deferred runner to prove concurrent second execution cannot increment the attempt count. Also cover duplicate execution after success and after rejection, unchanged rejection identity, between-stage abort reason, no abort listener added by preparation, and exact payload/auth/telemetry/side-input identity. Retain short-circuit and execution/respond failure cleanup coverage.

- [x] **Migrate the actual consumers and side-input contracts.** Generic serve uses prepare -> execute -> respond. Responses performs both phases inside its current turn callback. Add explicit Responses/Messages/Gemini/Chat Completions side-input types and remove their dictionary-value casts. Keep warmup, `onPrepared`, local continuation, compact stream override and inbound headers unchanged. Update obsolete comments describing preparation as already executing.

- [x] **Run focused validation and self-review.** Run the kit test and the four protocol serve tests plus Responses turn-barrier and dump exception ownership tests. Run kit and gateway typechecks and framework purity. Review the full diff for an extra inference, a moved quota/history gate, detached diagnostics or changed JSON/SSE semantics. Do not run benchmarks.

- [x] **Commit only scoped source/tests.** Use `refactor(vnext): separate request preparation from execution`. Write the implementation report with RED/GREEN evidence, source files, commands and results. Report any unexplained failure rather than changing unrelated behavior.

## Qualification and integration

- [x] Independently review task compliance and code quality; resolve findings and check overlay hashes.
- [x] Run `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` from the isolated `vnext` on the final artifact, recording the exact source commit and overlay.
- [x] Complete final combined review, record qualification and finish all checkboxes supported by evidence.
- [x] Fast-forward local `vNext`, verify scoped file equality and preservation of the original working-tree bytes, then report the reference mechanisms adopted and remaining architecture increments.

Evidence: [implementation and qualification record](../research/2026-10-01-request-stage-contracts/README.md). Source commits: `9b387b4c` and `717cd86e`; the latter resolves the independent review's request-retention finding. Final local CI: 5616 pass, 1 existing skip, 0 fail, with all qualification stages passing.
