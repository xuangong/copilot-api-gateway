Archived from the preserved isolated-worktree evidence directory `.superpowers/sdd/2026-10-01-diagnostic-resource-contracts/`. Relative raw-log paths in this report refer to that directory.

# Task 1 review

## Spec Compliance

- ❌ Issues found: `vnext/packages/gateway/src/shared/dump/capture-budget.ts:185` can leave the memoized retirement promise pending forever when observing an accepted promise throws synchronously. It also stops observing the other phase, violating the requirement to observe both operations immediately, settle retirement and release once after both phase outcomes are known. See Important I1.
- ✅ The diff implements the separate capture/owner interfaces and removes public raw accounting authority (`capture-budget.ts:72`, `capture-budget.ts:81`, `capture-budget.ts:98`). Every unconditionally requested file has its corresponding change; extending the SQLite suite was conditional and its existing focused coverage was reported passing.
- ⚠️ The diff cannot establish all 38 main and 14 isolated protected files remain byte-identical, the existing fixture is still alive, or the complete cross-task integration contract. The saved `task-1-evidence/protect.log:1` reports all protected hashes matching; the controller remains responsible for final preservation and frozen-source CI checks. No performance improvement was measured or claimed.

## Strengths

- `vnext/packages/gateway/src/shared/dump/capture-budget.ts:98`: ECMAScript private state and separate module-local facade/scope classes hide mutation authority at runtime as well as through types. The public capture has admission methods and facts without early release or retirement.
- `vnext/packages/gateway/src/shared/dump/capture-budget.ts:182`: the completion receipt is stored before calling promise observation code, so synchronous reentry returns the same receipt and replacement inputs cannot acquire ownership.
- `vnext/packages/gateway/src/shared/dump/capture-budget.ts:160`: the terminal reaction captures accounting state and the completion receipt rather than the work/preparation inputs; normal fulfillment/rejection waits for both phases and gives preparation rejection precedence.
- `vnext/packages/gateway/src/shared/dump/accumulator.ts:183`, `:216`, `:406`, `:431`, `:499`: migration preserves work creation, retirement selection, registration and persistence continuation owners. Admission stays open while the drain runs.
- `vnext/packages/gateway/src/shared/dump/__tests__/capture-contract.test.ts:5` and `vnext/packages/gateway/tests/dump-capture-budget.test.ts:4`: source-included assertions and runtime checks cover the authority boundary; the new deferred matrix exercises both settlement orders, rejection precedence, pending admission and post-retirement refusal.

## Issues

### Critical (Must Fix)

- None.

### Important (Should Fix)

- **I1 — Synchronous observation failure leaks the retirement owner.** `vnext/packages/gateway/src/shared/dump/capture-budget.ts:185`: `Promise.allSettled([work, preparation])` itself can reject if a native Promise has a throwing `then` getter/method. Its iteration then stops before observing the remaining input. Only a fulfillment handler is registered, so `finishRetirement` never runs, the separately memoized receipt never settles, and the discarded derived promise rejects unhandled. Both underlying promises can subsequently fulfill while their capture charge remains retained permanently; every repeated retirement returns the stuck receipt. This is adjacent to the explicitly supported synchronous `then` reentry scenario, not an ordinary work/preparation rejection covered by the matrix. Isolate observation of each phase so a synchronous observation error becomes that phase's rejected outcome, always observe the other phase, and preserve both-phase waiting plus preparation-error precedence. Merely adding an aggregate rejection handler would still miss the unobserved phase. Add a focused regression for throwing observation on either phase with the other phase deferred.

### Minor (Nice to Have)

- **M1 — Recorded lint output is not pristine.** `.superpowers/sdd/2026-10-01-diagnostic-resource-contracts/task-1-evidence/scoped-lint.log:1` emits the existing multiple-tsconfig performance advisory. The command exited successfully with no code diagnostics; this is pre-existing tooling noise, not a source defect or a blocker. Address it in the lint invocation/configuration when that tooling is next changed, without broadening this task.

## Checks and focused reproduction

- Read the supplied diff once. Additional source check for the named accumulator ownership/reentry risk: inspected only `this.retire`, `terminalWrite`, and `preparationSettled` call-site contexts in `accumulator.ts`; no changed scheduler or phase order found.
- Additional source check for the named runtime-primitive risk: searched gateway source for `Promise.withResolvers`; existing uses include `accumulator.ts:426` and multiple data-plane responders, so this task adds no new runtime primitive requirement. An initial filename glob failed without executing the search; the corrected focused source search succeeded.
- Read the saved RED outputs: three TS2344 assignability failures and the runtime authority test failure match the claimed initial contract RED. Read the saved GREEN typecheck/framework outputs and focused-test summary: 110 pass, 0 fail, 795 assertions. Did not rerun any reported suite.
- Ran exactly one targeted reproduction using `bun -` from `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix/vnext`, importing `./packages/gateway/src/shared/dump/capture-budget.ts`. No reproduction file was created:

```ts
const budget = new DumpCaptureBudget()
const scope = budget.open()
scope.capture.bytes(900)
const work = Promise.withResolvers<void>()
const preparation = Promise.withResolvers<void>()
const observationError = new Error("work observation failed")
Object.defineProperty(work.promise, "then", {
  get() { throw observationError },
})
let preparationObserved = false
const originalThen = preparation.promise.then.bind(preparation.promise)
Object.defineProperty(preparation.promise, "then", {
  value: (...args: Parameters<typeof preparation.promise.then>) => {
    preparationObserved = true
    return originalThen(...args)
  },
})
const unhandled: unknown[] = []
process.on("unhandledRejection", error => { unhandled.push(error) })
let retirementSettled = false
const retirement = scope.retire(work.promise, preparation.promise)
void retirement.then(
  () => { retirementSettled = true },
  () => { retirementSettled = true },
)
work.resolve()
preparation.resolve()
await Bun.sleep(0)
console.log(JSON.stringify({
  preparationObserved,
  retirementSettled,
  retainedBytes: budget.retainedBytes,
  unhandledObservationError: unhandled.includes(observationError),
  sameReceipt: scope.retire(Promise.resolve(), Promise.resolve()) === retirement,
}))
```

- Reproduction exited 0 and printed exactly:

```json
{"preparationObserved":false,"retirementSettled":false,"retainedBytes":900,"unhandledObservationError":true,"sameReceipt":true}
```

- No source, index, Git state, dependencies, fixture/service or production state was changed; only this requested review artifact was written.

## Assessment

**Task quality:** Needs fixes.

**Reasoning:** The authority split and normal two-phase lifecycle are compact and well covered, and accumulator ordering is preserved. I1 prevents trusting the advertised observation/reentry contract until per-phase observation failures are handled without losing the other phase or leaving the owner pending.
