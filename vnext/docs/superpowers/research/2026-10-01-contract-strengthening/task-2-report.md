# Task 2: translated producer domain contracts

Status: DONE

Worktree: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`

Branch: `fix/cfw-resource-rollback`

Baseline: `a3eb50537f37928d6729f4ca6e560f9858a948fc`

Commit: `57a8ec926c29303421e7259e981f69093f55741d`

Commit message: `refactor(vnext): align translated producer domain contracts`

## Exact scope and implementation

The commit contains exactly six specified files, 84 insertions and six deletions:

- `vnext/packages/protocols-llm/src/common/result.ts`
- `vnext/packages/protocols-llm/src/common/index.ts`
- `vnext/packages/protocols-llm/src/common/__tests__/producer-contract.test.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/hub-attempt-dispatch.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/shared/producer-domain.test.ts`

`TranslatedProducerProtocol = Exclude<TranslatorProtocol, "gemini">` is exported through the protocols common entry point. `TranslatedLlmEventResult.producer.protocol` and `TraverseTranslationArgs.hubProtocol` use it, and `HubAttemptProtocol` is an alias of that shared type. The gateway fixture's two hub arguments now use the same type; its source protocol alias and deliberate malformed foreign-input fixtures are unchanged.

No runtime guard, dispatch implementation, traversal body, adapter, producer ownership or telemetry semantics changed. `TranslatorProtocol` retains all four values. Gemini is still valid for native results, translator sources, the source field of translated results, and translator telemetry. The narrowing concerns only the supported translated producer/hub domains: chat_completions, messages and responses.

No Task 1 or Task 3 file, protected overlay or controller-owned document was edited/staged. No attempt file changed. No push, deployment, restart, dependency installation, production access, benchmark or full CI was performed, and no subagent was spawned. This report and logs remain ignored local evidence outside the commit.

## Type-contract RED evidence

The new test initially imported only existing exports and checked the current `TranslatedLlmEventResult` producer field. It did not import the new shared export until implementation. These two assertions failed before narrowing:

- `"gemini" extends TranslatedLlmEventResult["producer"]["protocol"]` was true, so the rejection assertion failed.
- A complete translated result shape with producer `{ kind: "translated"; source: "responses"; protocol: "gemini" }` was assignable, so the complete-construction rejection assertion failed.

Checks accepting each supported hub, a translated Gemini source, general Gemini translator/native protocols, and Gemini telemetry already passed. This demonstrates the existing type/runtime mismatch rather than merely an absent export.

From `vnext/`:

```sh
bun run --filter '@vibe-llm/protocols' typecheck > ../.superpowers/sdd/2026-10-01-contract-strengthening/task-2-red-protocol-typecheck.log 2>&1
```

Exit 2. The original raw output is retained in `task-2-red-protocol-typecheck.log`:

```text
@vibe-llm/protocols typecheck: src/common/__tests__/producer-contract.test.ts(13,39): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-llm/protocols typecheck: src/common/__tests__/producer-contract.test.ts(15,3): error TS2344: Type 'false' does not satisfy the constraint 'true'.
@vibe-llm/protocols typecheck: Exited with code 2
```

The assertions are under `src/common/__tests__/`, included by the ordinary package tsconfig. They use `Assert<T extends true>` without suppression directives. After implementation the original checks pass, along with an equality assertion proving the producer field is exactly the exported shared type. RED was not reconstructed after implementation.

## Runtime characterization before narrowing

```sh
bun test packages/protocols-llm/src/common/__tests__/producer-contract.test.ts > ../.superpowers/sdd/2026-10-01-contract-strengthening/task-2-runtime-characterization.log 2>&1
```

Exit 0: 3 pass, 0 fail, 6 assertions. `task-2-runtime-characterization.log`.

These tests establish preserved behavior: native Gemini returns its native domain; Gemini sources accept each supported producer domain; and a deliberately foreign translated Gemini producer fails the unchanged runtime guard. The foreign fixture explicitly crosses the trusted type boundary through `unknown` so it still exercises runtime validation after the type restriction. No mock or suppression was used.

## GREEN, focused regression, purity and lint

Every command in this section ran from `vnext/`. All logs capture original stdout/stderr directly from the invoked command.

```sh
bun run --filter '@vibe-llm/protocols' typecheck > ../.superpowers/sdd/2026-10-01-contract-strengthening/task-2-protocol-typecheck.log 2>&1
```

Exit 0. Raw output: `task-2-protocol-typecheck.log`.

```sh
bun run --filter '@vibe-llm/gateway' typecheck > ../.superpowers/sdd/2026-10-01-contract-strengthening/task-2-gateway-typecheck.log 2>&1
```

Exit 0. Raw output: `task-2-gateway-typecheck.log`.

```sh
bun run --filter '@vibe-llm/provider-copilot' typecheck > ../.superpowers/sdd/2026-10-01-contract-strengthening/task-2-provider-copilot-typecheck.log 2>&1
```

Exit 0. Raw output: `task-2-provider-copilot-typecheck.log`.

```sh
bun run scripts/check-framework-purity.ts > ../.superpowers/sdd/2026-10-01-contract-strengthening/task-2-purity.log 2>&1
```

Exit 0. Raw output: `task-2-purity.log`.

```sh
bunx --no-install eslint packages/protocols-llm/src/common/result.ts packages/protocols-llm/src/common/index.ts packages/protocols-llm/src/common/__tests__/producer-contract.test.ts packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts packages/gateway/src/data-plane/chat-flow/shared/hub-attempt-dispatch.ts packages/gateway/tests/data-plane/chat-flow/shared/producer-domain.test.ts > ../.superpowers/sdd/2026-10-01-contract-strengthening/task-2-scoped-lint.log 2>&1
```

Exit 0. Raw output: `task-2-scoped-lint.log`.

All three ordinary typechecks passed: protocols, gateway and provider-copilot. Purity printed `[framework-purity] OK`. Scoped ESLint had no file diagnostics or errors; the existing TypeScript import resolver emitted its multiple-tsconfig performance advisory. No warning suppression or unrelated cleanup was introduced.

```sh
bun test packages/protocols-llm/tests/common/result.test.ts packages/protocols-llm/src/common/__tests__/producer-contract.test.ts packages/gateway/tests/data-plane/chat-flow/shared/producer-domain.test.ts packages/gateway/tests/data-plane/chat-flow/shared/producer-cleanup.test.ts packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.test.ts packages/gateway/tests/data-plane/chat-flow/responses/interceptors/producer-domain.test.ts > ../.superpowers/sdd/2026-10-01-contract-strengthening/task-2-focused-tests.log 2>&1
```

Exit 0. Full raw output: `task-2-focused-tests.log`.

```text
 89 pass
 0 fail
 247 expect() calls
Ran 89 tests across 6 files. [3.05s]
```

The suites cover common result construction and the new compile/runtime contracts, real cross-protocol JSON/SSE responders with missing/stale telemetry, malformed producer rejection, bounded iterator/body disposal, nested translation cleanup, traversal metadata/errors/header inheritance, and Responses compact/hosted-tool producer conversion. Existing Gemini source tests passed. Malformed foreign fixtures continue failing at runtime without consuming invalid frames, while concrete unopened body disposal and failed execution facts keep their prior owners.

The traversal fixture still emits the pre-existing `eventResultMetadata: finalMetadata set without __interceptorReplaced provenance flag` diagnostic; no related source/test body was changed. The complete log preserves it.

## Commit and independent protected-file check

From the worktree root, `git diff --check`, `git diff --cached --check` and the initial cached-name query all exited 0 with no output. Explicit staging was:

```sh
git add -- vnext/packages/protocols-llm/src/common/result.ts vnext/packages/protocols-llm/src/common/index.ts vnext/packages/protocols-llm/src/common/__tests__/producer-contract.test.ts vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts vnext/packages/gateway/src/data-plane/chat-flow/shared/hub-attempt-dispatch.ts vnext/packages/gateway/tests/data-plane/chat-flow/shared/producer-domain.test.ts
git diff --cached --name-only
git diff --cached --check
git diff --cached --stat
git commit -m 'refactor(vnext): align translated producer domain contracts' > .superpowers/sdd/2026-10-01-contract-strengthening/task-2-commit.log 2>&1
git rev-parse HEAD
```

All exited 0. Cached names and stat contained only the six allowed files, and the resulting SHA is `57a8ec926c29303421e7259e981f69093f55741d`. Commit output: `task-2-commit.log`.

The 14 isolated hashes matched before Task 2. The following independent post-commit check verifies them again, asserts the committed file set exactly, compares unchanged runtime implementation regions to the Task 2 baseline, and checks the historical retention probe:

```sh
python3 - > .superpowers/sdd/2026-10-01-contract-strengthening/task-2-protected-hashes.log 2>&1 <<'PY'
import hashlib,json,pathlib,subprocess
root=pathlib.Path('.')
w=root/'.superpowers/sdd/2026-10-01-contract-strengthening'
manifest=json.loads((w/'isolated-protected-files.json').read_text())
for name,expected in manifest.items():
    actual=hashlib.sha256((root/name).read_bytes()).hexdigest()
    assert actual==expected, name
    print('MATCH', name, actual)
expected={
'vnext/packages/protocols-llm/src/common/result.ts',
'vnext/packages/protocols-llm/src/common/index.ts',
'vnext/packages/protocols-llm/src/common/__tests__/producer-contract.test.ts',
'vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts',
'vnext/packages/gateway/src/data-plane/chat-flow/shared/hub-attempt-dispatch.ts',
'vnext/packages/gateway/tests/data-plane/chat-flow/shared/producer-domain.test.ts',
}
actual=set(subprocess.check_output(['git','show','--format=','--name-only','HEAD'],text=True).splitlines())
assert actual==expected, actual
for name,marker in [
('vnext/packages/protocols-llm/src/common/result.ts','export function eventProducerProtocol'),
('vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts','export async function traverseTranslation'),
('vnext/packages/gateway/src/data-plane/chat-flow/shared/hub-attempt-dispatch.ts','export function pickHubAttempt'),
]:
    current=(root/name).read_text()
    base=subprocess.check_output(['git','show','a3eb5053:'+name],text=True)
    assert current[current.index(marker):]==base[base.index(marker):], name
    print('MATCH runtime implementation', name)
probe=root/'vnext/docs/superpowers/research/2026-10-01-request-stage-contracts/retention-probe.ts'
assert hashlib.sha256(probe.read_bytes()).hexdigest()=='a9e2d725096c5346735c9fc1e21259484f8218e1475c89e6b9a3df4350cbed2a'
print(f'All {len(manifest)} protected hashes match; six-file commit scope, runtime bodies and historical probe verified.')
PY
```

Exit 0. Full values and outcomes: `task-2-protected-hashes.log`. It printed:

```text
All 14 protected hashes match; six-file commit scope, runtime bodies and historical probe verified.
```

The first attempt to capture this Python heredoc log placed redirection after the closing delimiter and failed with a SyntaxError before any verification code executed. Redirection was moved to the command's first line, then the complete check above passed. The original capture error is retained in `task-2-hash-capture-error.log`; it caused no source/state change and is not a product failure.

Post-commit status retains the original ten tracked dirty and four untracked isolated overlays, plus the controller's documentation/research changes. None is staged in this commit, and no Task 2 implementation file remains uncommitted. The main checkout and its 38 protected files were not touched by this agent; cross-checkout integration remains controller-owned.

## Self-review and limits

- The actual translated producer field is narrowed, not just the exported alias. A complete Gemini translated-result construction is rejected under the normal protocol typecheck.
- Each supported hub is still accepted. Source/native Gemini and general translator/telemetry unions remain broad by design.
- The runtime `eventProducerProtocol` guard and all subsequent common runtime helpers are byte-identical to the baseline. `traverseTranslation` and `pickHubAttempt` implementation regions are also byte-identical, as checked independently after commit.
- Native results still exclude translation adapters. Translated results still require distinct body/event adapters, retain hub frame ownership, and hand conversion to source consumers lazily. No parser or raw-response converter was added.
- Existing invalid/unknown/wrong-source producer fixtures retain their deliberate foreign-input casts and runtime rejection assertions. The new Gemini-invalid fixture is complete enough to isolate the unsupported producer-domain branch.
- Producer discard, unopened body release, nested-result rejection, metadata identity, native JSON, cleanup bounds, and continuation ownership are unchanged. The focused regression results support those retained behaviors; no new lifecycle or settlement owner was introduced.
- No any type, suppression, new non-null assertion, schema, flag, environment variable or retry change was added. Core dependencies remain domain-neutral.
- This is an internal type-contract alignment, not evidence of a production routing incident, a newly supported protocol pair, a performance gain or quantitative resource bounds.
- Independent review and final whole-branch CI/integration are pending controller gates. Full CI was intentionally not run for this isolated task.

No unresolved implementation concern was found.

## Raw evidence location

Log filenames in this archived report refer to the preserved local worktree directory `.superpowers/sdd/2026-10-01-contract-strengthening/`. Raw logs remain outside tracked product documentation.
