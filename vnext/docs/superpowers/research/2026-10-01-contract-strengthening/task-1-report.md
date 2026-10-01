# Task 1: prepared request output contracts

Status: DONE

Worktree: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`

Branch: `fix/cfw-resource-rollback`

Baseline: `aaa6494257b2f6b3778562a969d45405e726b653`

Commit: `a3eb50537f37928d6729f4ca6e560f9858a948fc`

Commit message: `refactor(vnext): enforce prepared request output contracts`

## Implementation and exact scope

The commit contains exactly 12 permitted files, 167 insertions and 51 deletions:

- `vnext/packages/chat-flow-kit/src/serve-template.ts`
- `vnext/packages/chat-flow-kit/src/serve-template.test.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/serve.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/gemini/serve.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/local-continuation.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/serve-contracts.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/serve.test.ts`
- `vnext/packages/gateway/tests/dump-accumulator.test.ts`
- `vnext/packages/gateway/tests/dump-exception-ownership.sqlite.test.ts`

The core now requires `preProcess` and carries exact `TExtra` through attempt, response, telemetry, ready and execution results. The existing preparation try/catch always awaits this stage, derives payload and extra from its continue result, and preserves the existing early response branch. Early preparation results and the outer serve result retain `TExtra | undefined`.

The gateway declares `PreparedModelIdentity = { readonly incomingModel: string }` as the minimum extra accepted by `kitDeps`. Both the object-boundary check and invalid/empty incoming-model checks remain intact; the unknown record cast is removed. Required extra reads in all four endpoints are direct. Optional fields inside each extra remain optional. Gemini's redundant missing-extra guard is removed.

The exported `ResponsesPreparedObserver` returns `undefined` and accepts `Readonly<Record<string, unknown>>`. Its invocation is still synchronous at the same point after history expansion and before routing/affinity. The existing session callback has no behavioral change. The read-only annotation on `ResponsesLocalContinuation.candidate` propagates that observation view to its serialization helper without copying, freezing or changing stored history.

Only the two explicit dump hook fixtures received no-op preprocessing. The default kit fixture's declared extra already includes undefined and gets an explicit no-op. The explicit undefined-only fixture checks the entire successful handoff. Fixtures with concrete extra values retain their concrete preprocessing results.

Tasks 2 and 3 were not implemented. Protected overlays and controller-owned documentation were not edited or staged. No push, deployment, restart, installation, production access, benchmark, or full CI was performed. No subagents were used. Full integration CI and independent review remain controller-owned gates.

## RED/GREEN evidence and raw log provenance

The type assertions were written before production changes, using `Assert<T extends true>` without suppression. All type/test/purity/lint commands below ran from `vnext/` unless marked as worktree-root commands.

Core RED contained six TS2344 diagnostics: omission of preprocessing remained assignable and each of the five successful contexts added undefined to concrete extra. The checks for explicit undefined extra and the early/outer optional branch already passed.

Gateway RED contained four TS2344 diagnostics: broad void and async callbacks remained assignable, the observer payload was mutable, and its exact read-only view assertion failed. The equality/writability utility checks readonly index signatures without an unsafe cast.

After implementation the same package typechecks passed with all these assertions included by their ordinary tsconfigs. Additional named-observer and typed kit dependency equality checks also pass.

The raw RED/GREEN output files below were saved from the original tool results captured during this run. RED was not reconstructed or rerun after implementation. Runtime observer rejection tests were characterized before implementation and passed, because the goal is to preserve existing synchronous behavior while closing unsafe type constructions.

### RED kit typecheck

Working directory: vnext/.

```sh
bun run --filter '@vibe-core/chat-flow-kit' typecheck
```

Exit code: 2. Raw output: `task-1-red-kit-typecheck.log`.

```text
@vibe-core/chat-flow-kit typecheck: src/serve-template.test.ts(38,3): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-core/chat-flow-kit typecheck: src/serve-template.test.ts(40,34): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-core/chat-flow-kit typecheck: src/serve-template.test.ts(41,34): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-core/chat-flow-kit typecheck: src/serve-template.test.ts(42,36): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-core/chat-flow-kit typecheck: src/serve-template.test.ts(43,32): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-core/chat-flow-kit typecheck: src/serve-template.test.ts(44,35): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-core/chat-flow-kit typecheck: Exited with code 2
```

### RED gateway typecheck

Working directory: vnext/.

```sh
bun run --filter '@vibe-llm/gateway' typecheck
```

Exit code: 2. Raw output: `task-1-red-gateway-typecheck.log`.

```text
@vibe-llm/gateway typecheck: src/data-plane/chat-flow/responses/serve-contracts.test.ts(10,38): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-llm/gateway typecheck: src/data-plane/chat-flow/responses/serve-contracts.test.ts(11,37): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-llm/gateway typecheck: src/data-plane/chat-flow/responses/serve-contracts.test.ts(13,33): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-llm/gateway typecheck: src/data-plane/chat-flow/responses/serve-contracts.test.ts(14,36): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-llm/gateway typecheck: Exited with code 2
```

### Existing synchronous rejection behavior characterization before implementation

Working directory: vnext/.

```sh
bun test packages/gateway/tests/data-plane/chat-flow/responses/serve.test.ts
```

Exit code: 0. Raw output: `task-1-observer-characterization.log`.

```text
bun test v1.3.0 (b0a6feca)

packages/gateway/tests/data-plane/chat-flow/responses/serve.test.ts:
(pass) compact dump retains source while previous response is expanded and model is routed [22.83ms]
(pass) HTTP callers can omit returned history while internal callers retain expanded items [0.57ms]
(pass) synchronous prepared observer rejection precedes inference [5.24ms]
(pass) synchronous prepared observer rejection precedes warmup validation [0.39ms]

 4 pass
 0 fail
 21 expect() calls
Ran 4 tests across 1 file. [1.56s]
```

### GREEN kit typecheck

Working directory: vnext/.

```sh
bun run --filter '@vibe-core/chat-flow-kit' typecheck
```

Exit code: 0. Raw output: `task-1-green-kit-typecheck.log`.

```text
@vibe-core/chat-flow-kit typecheck: Exited with code 0
```

### GREEN gateway typecheck

Working directory: vnext/.

```sh
bun run --filter '@vibe-llm/gateway' typecheck
```

Exit code: 0. Raw output: `task-1-green-gateway-typecheck.log`.

```text
@vibe-llm/gateway typecheck: Exited with code 0
```

### Framework purity

Working directory: vnext/.

```sh
bun run scripts/check-framework-purity.ts
```

Exit code: 0. Raw output: `task-1-purity.log`.

```text
[framework-purity] OK
```

### Scoped lint

Working directory: vnext/.

```sh
bunx --no-install eslint packages/chat-flow-kit/src/serve-template.ts packages/chat-flow-kit/src/serve-template.test.ts packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts packages/gateway/src/data-plane/chat-flow/responses/serve.ts packages/gateway/src/data-plane/chat-flow/messages/serve.ts packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts packages/gateway/src/data-plane/chat-flow/gemini/serve.ts packages/gateway/src/data-plane/chat-flow/responses/local-continuation.ts packages/gateway/src/data-plane/chat-flow/responses/serve-contracts.test.ts packages/gateway/tests/data-plane/chat-flow/responses/serve.test.ts packages/gateway/tests/dump-accumulator.test.ts packages/gateway/tests/dump-exception-ownership.sqlite.test.ts
```

Exit code: 0. Raw output: `task-1-scoped-lint.log`.

```text
Multiple projects found, consider using a single `tsconfig` with `references` to speed up, or use `noWarnOnMultipleProjects` to suppress this warning

/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix/vnext/packages/gateway/tests/dump-accumulator.test.ts
  8:24  warning  'beforeEach' is defined but never used. Allowed unused vars must match /^_/u  @typescript-eslint/no-unused-vars

✖ 1 problem (0 errors, 1 warning)
```

### Scoped commit

Working directory: worktree root.

```sh
git commit -m 'refactor(vnext): enforce prepared request output contracts'
```

Exit code: 0. Raw output: `task-1-commit.log`.

```text
[fix/cfw-resource-rollback a3eb5053] refactor(vnext): enforce prepared request output contracts
 12 files changed, 167 insertions(+), 51 deletions(-)
 create mode 100644 vnext/packages/gateway/src/data-plane/chat-flow/responses/serve-contracts.test.ts
```

### Post-commit protected/hash/scope verification

Working directory: worktree root.

```sh
python3 - <<'PY'
import hashlib,json,pathlib,subprocess
root=pathlib.Path('.')
w=root/'.superpowers/sdd/2026-10-01-contract-strengthening'
manifest=json.loads((w/'isolated-protected-files.json').read_text())
for name,expected in manifest.items():
    actual=hashlib.sha256((root/name).read_bytes()).hexdigest()
    assert actual==expected, name
    print('MATCH', name, actual)
probe=root/'vnext/docs/superpowers/research/2026-10-01-request-stage-contracts/retention-probe.ts'
probe_hash=hashlib.sha256(probe.read_bytes()).hexdigest()
assert probe_hash=='a9e2d725096c5346735c9fc1e21259484f8218e1475c89e6b9a3df4350cbed2a'
assert probe.read_bytes()==subprocess.check_output(['git','show','aaa64942:'+str(probe)])
print('MATCH historical retention probe', probe_hash)
expected={
'vnext/packages/chat-flow-kit/src/serve-template.ts',
'vnext/packages/chat-flow-kit/src/serve-template.test.ts',
'vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts',
'vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts',
'vnext/packages/gateway/src/data-plane/chat-flow/messages/serve.ts',
'vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts',
'vnext/packages/gateway/src/data-plane/chat-flow/gemini/serve.ts',
'vnext/packages/gateway/src/data-plane/chat-flow/responses/local-continuation.ts',
'vnext/packages/gateway/src/data-plane/chat-flow/responses/serve-contracts.test.ts',
'vnext/packages/gateway/tests/data-plane/chat-flow/responses/serve.test.ts',
'vnext/packages/gateway/tests/dump-accumulator.test.ts',
'vnext/packages/gateway/tests/dump-exception-ownership.sqlite.test.ts',
}
actual=set(subprocess.check_output(['git','show','--format=','--name-only','HEAD'],text=True).splitlines())
assert actual==expected, actual
print(f'All {len(manifest)} protected files and the historical retention probe match; commit scope is exactly {len(expected)} allowed files.')
PY
```

Exit code: 0. Raw output: `task-1-protected-hashes.log`.

## Combined focused behavior run

```sh
bun test packages/chat-flow-kit/src/serve-template.test.ts packages/gateway/tests/data-plane/chat-flow/responses/serve.test.ts packages/gateway/tests/data-plane/chat-flow/messages/serve.test.ts packages/gateway/tests/data-plane/chat-flow/chat-completions/serve.test.ts packages/gateway/tests/data-plane/chat-flow/gemini/serve.test.ts packages/gateway/tests/data-plane/chat-flow/responses/session.sqlite.test.ts packages/gateway/tests/data-plane/chat-flow/responses/session-limits.test.ts packages/gateway/tests/data-plane/chat-flow/responses/turn-barrier.test.ts packages/gateway/tests/dump-accumulator.test.ts packages/gateway/tests/dump-exception-ownership.sqlite.test.ts > ../.superpowers/sdd/2026-10-01-contract-strengthening/task-1-focused-tests.log 2>&1
```

Exit code: 0. Full, untruncated stdout/stderr from the command is retained in `task-1-focused-tests.log`.

```text
 191 pass
 0 fail
 880 expect() calls
Ran 191 tests across 10 files. [9.48s]
```

Coverage includes kit preparation/execution, all four gateway serve suites, Responses session SQLite and local limits, turn barriers, and both dump suites. This is the requested focused run, not full CI.

The two new observer tests preserve the original 413 admission envelope and confirm both generation and warmup validation are never entered after a synchronous observer throw. The spies observe real exported entry points and are restored in finally; no module or SQLite mock was introduced. The observer sees the incoming model before routing.

Kit behavior coverage verifies prepared payload/extra/auth/input/controller/context reference identity; no inference during preparation; consumption before the original runner settles; preserved rejection identity and permanent consumption after rejection; no telemetry/quota/attempt/respond on preprocessing failure; short-circuit and parse envelopes; and explicit undefined-only no-op preprocessing. Existing session tests verify warmup performs zero inference calls, shares quota and eligibility checks, preserves continuation/reentry, and creates no generation billing/performance usage. Native JSON and continuation ownership retain their existing tested behavior.

## Self-review and preservation checks

- Exact successful extra is proven through normal control flow from `pre.extra`; there is no `as TExtra`, missing-extra assertion, compatibility overload, newly added non-null assertion, suppression, or any type.
- Parse, requested-model dump stamping, preprocessing/history, stream choice, telemetry, quota and attempt remain in the existing order. Production preprocessing bodies, observer position, routing decisions, authentication, error rendering and retry policy are unchanged.
- The private execution capability and synchronously cleared pending runner remain unchanged. The observer and extra changes create no independent lifecycle, completion, diagnostic, continuation or transport owner.
- Payload and extra are borrowed references. The observer's view prevents top-level assignment in trusted TypeScript; it does not freeze nested values or sandbox arbitrary casts/detached work. No runtime Promise inspection or deep copy was introduced.
- The kit remains domain-neutral. Framework purity passed, and no core package imports gateway/protocol types.
- Changed production code was inspected against the baseline. Only required-stage control flow, stronger annotations, and removal of optional reads/one redundant guard changed.
- Scoped ESLint exited 0 with zero errors. The unused `beforeEach` import warning in `dump-accumulator.test.ts:8` is present at the baseline and is untouched by this task. The multiple-tsconfig resolver advisory is also informational. No new lint diagnostic was introduced; unrelated warning cleanup was not included.
- `git diff --check` and `git diff --cached --check` exited 0 with no output. The index was initially empty. Explicit staging and cached-name inspection selected exactly the 12 files listed above; the post-commit script asserts the committed file set equals that list.
- All 14 isolated protected SHA-256 values match `isolated-protected-files.json` before implementation, after verification, and after commit. Complete final values are in `task-1-protected-hashes.log`.
- The historical retention probe remains byte-identical to baseline `aaa64942`, with SHA-256 `a9e2d725096c5346735c9fc1e21259484f8218e1475c89e6b9a3df4350cbed2a`. No compatibility overload or probe edit was used to bypass the required stage.
- Post-commit status retains the original ten tracked dirty and four untracked isolated overlays. The two controller-owned documentation edits also remain outside this commit. No Task 1 implementation file remains uncommitted.
- The main checkout and its 38 protected files were not touched by this agent. The controller owns cross-checkout protection/integration verification.

No unresolved implementation concern was found. The API tightening intentionally rejects omitted preprocessing, asynchronous/broad-void observers, and unjustified successful-extra undefined. Historical research code retains its original source as required and is not claimed compatible with the stronger API. No capacity, performance or deployment-readiness claim follows from this task.

This report and its evidence logs are local review artifacts under `.superpowers/`, outside the implementation commit.

## Raw evidence location

Log filenames in this archived report refer to the preserved local worktree directory `.superpowers/sdd/2026-10-01-contract-strengthening/`. Raw logs remain outside tracked product documentation.
