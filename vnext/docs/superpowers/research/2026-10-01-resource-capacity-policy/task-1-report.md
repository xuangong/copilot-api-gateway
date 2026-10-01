# Task 1 implementation report

Status: DONE_WITH_CONCERNS (existing lint warning only). Date: 2026-10-01.

Base: `bf4db4312d4c0c85eaf8449f041e90a5d00c24e9`.
Commit: `54289f3c2c5b181952bb672e244729a596e62508`.
Worktree: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`.

## Scope and implementation

Only hosted search operation admission was implemented. All eight validated policy defaults are declared for subsequent tasks: operations 64; response body 1 MiB; ingress 8 MiB; private replay 64 entries / 4 MiB; page cache 64 entries / 2 MiB; Chat continuation 4 MiB. Body/replay/cache/diagnostic enforcement is not implemented by this task.

Admission counts before parser expansion, argument slices, plan/slot allocation and provider work. It uses array length (including holes) and own-key `for...in` enumeration with `Object.hasOwn`, saturating before later fields. Supported undefined fields contribute zero; unsupported undefined contributes one; null/empty calls have a minimum charge of one. A valid multi-query plan still charges each query independently. Reservation is synchronous and whole-call atomic; rejected calls reserve nothing. Prepared, refused and abandoned reservations do not refund.

Opaque branded tokens are registered in a scope-private map associated with the exact admitted argument object. Cross-scope and repeated consumption fail. prepare consumes before parsing; refuse consumes without parsing. Cancellation clears token ownership and still retains the existing real work/usage settlement tracker. Admission rechecks cancellation after argument reflection.

Both actual callers acquire admission before their normal/iteration-refusal branches, and preserve one scope over reentry. Capacity errors escape to their existing failure owner rather than becoming successful refusal text or extra model turns. Provider/usage semantics, fanout, batching, cancellation and real settlement remain intact.

## Explicit committed files

- `vnext/packages/gateway/src/data-plane/tools/web-search/capacity.ts`
- `vnext/packages/gateway/src/data-plane/tools/web-search/execution-scope.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/web-search.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.ts`
- `vnext/packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tools/web-search-fanout.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts`

Only these paths were staged. Root documentation and all protected overlays remained unstaged.

## RED and GREEN evidence

All log paths below are relative to this report's directory. Commands ran at the worktree root unless stated otherwise.

Initial RED, before production admission code:

```sh
bun test vnext/packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts
```

`task-1-red.log`: 12 pass / 5 fail, 41 assertions. Failures demonstrate missing admit/refuse behavior (admit is undefined). First scope GREEN: same command, `task-1-green-scope.log`, 17 pass / 0 fail, 51 assertions.

Caller discriminating RED: temporarily replace computed operation charge with constant 1 while preserving original arguments and all execution behavior; restore the exact source immediately after the test command. This demonstrates the caller checks fail from missing cardinality/cumulative admission, rather than malformed argument substitutions.

```sh
bun test vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tools/web-search-fanout.test.ts --test-name-pattern 'operation capacity.*(survives|Chat)'
```

`task-1-red-callers.log`: 0 pass / 4 fail / 44 filtered out, 37 assertions. Chat reentry/refusal/first-call overflow and Responses cross-turn refusal budget all fail when operation cardinality admission is disabled. No temporary mutation remains.

Final focused GREEN:

```sh
bun test vnext/packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts vnext/packages/gateway/tests/data-plane/tools/web-search/plan-operations.test.ts vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tools/web-search-fanout.test.ts vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tools/web-search-activation.test.ts
```

`task-1-green.log`: 96 pass / 0 fail, 323 assertions, 5 files, 1482 ms. Covers huge sparse rejection without element access, counting boundaries, exact limits, atomic rejected reservations, no refunds including parser failure, token ownership/consumption, safe typed failure, strict policy validation, refusal without parsing, early own-key saturation, cancellation during reflection, normal/malformed behavior, actual caller turns and refusal budgets, zero work for overflowing calls, and inherited cancellation/real settlement regression tests.

Responses exercises 30 two-query turns (60 fetches), then a four-operation refused call (no fetch), then rejects the next call. Chat exercises 32+32+1 across reentry, four 16-query turns plus an overflowing refusal, and a first 65-query call; no overflowing provider requests, refusal continuation or extra model turn are admitted.

## Verification commands

From `vnext/`:

```sh
bun run --filter '@vibe-llm/gateway' typecheck
bun scripts/check-framework-purity.ts
bunx eslint packages/gateway/src/data-plane/tools/web-search/capacity.ts packages/gateway/src/data-plane/tools/web-search/execution-scope.ts packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/web-search.ts packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.ts packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tools/web-search-fanout.test.ts packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts
```

- `task-1-typecheck.log`: exit 0. An earlier literal-inference error was corrected by explicitly typing the mutable validated policy record; final source passes.
- `task-1-purity.log`: `[framework-purity] OK`, exit 0.
- `task-1-lint.log`: exit 0, zero errors, one existing `require-yield` warning at Responses web-search generator (current line 615; the same generator is at base line 613). Resolver also emits its existing multiple-tsconfig informational warning.

From worktree root:

```sh
git diff --check
python3 .superpowers/sdd/2026-10-01-resource-capacity-policy/verify-artifact.py protect
```

Diff whitespace check passes. `task-1-protection.log` records 38 main and 14 isolated protected files matching their original hashes. Protection was repeated after commit and also passed with those exact counts.

## Self-review and concerns

Reviewed all three modified production paths and new policy source. No asynchronous admission, element enumeration, eager provider work, per-plan charging, refund, or new fallback/error swallowing was added. Tests validate counting and output behavior using real parser/planner and actual callers; existing provider and usage gates validate cancellation separately from real settlement.

The operation default is provisional engineering policy, not a measured isolate memory guarantee. Reflection and the preexisting JSON parse/input graph are outside the counted quantity. Token arguments remain borrowed until immediate prepare/refuse, as documented by the design.

Task 2 can reuse the safe capacity error/categories/policy module. If an ingress capacity failure must cancel concurrent work with the original capacity reason, the public scope `cancel(): undefined` currently accepts no argument; the existing internal cancel(reason) already supports parent reasons. A later task should extend that interface deliberately without conflating cancellation and real settlement. Task 1 does not add body capacity or branch cancellation behavior.

No full CI, deployment, push, install, runtime/service changes, production mutation, or benchmark was performed. Root owns the final combined CI/freeze and independent review.
