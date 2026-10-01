# Task 1 implementation report

Status: DONE

Worktree: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`

Branch: `fix/cfw-resource-rollback`

Starting commit: `840fdf2821ea0cb3a96f68e123caacfe8e9c48bf`

Implementation commit: `c1acacea816278d91ebcd9e4824a860857f61331`

Commit message: `refactor(vnext): define synchronous request normalization contracts`

## Scope

The commit contains exactly four files, with 182 insertions:

- `vnext/packages/service/src/request-transform.ts`: synchronous `RequestTransform<Req> = (req: Req) => undefined` and `beforeRequest<Ctx, Req, Result>`.
- `vnext/packages/service/src/index.ts`: only the new public export; existing interceptor and runner code is unchanged.
- `vnext/packages/service/src/__tests__/request-transform.test.ts`: six behavioral tests and three compile-time assertions.
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/request-normalization.ts`: `RequestNormalizationInput = Pick<Invocation, "payload" | "enabledFlags">`, `LlmRequestNormalizer`, and the wrapper returning the existing `LlmInterceptor<TResult>` with explicit `<RequestContext, Invocation, TResult>` delegation.

Task 2 production-consumer migrations were not started. No deployment, push, dependency install, service changes, or subagents were used. No documentation or existing dirty overlay was included in the commit. The concurrent controller research directory remains untracked and was not edited or staged by this task. This report is outside the commit.

## RED evidence

All test and typecheck commands below were run from the worktree's `vnext/` directory. Bun version reported by the tests: `v1.3.0 (b0a6feca)`.

First, the new test file was written while the export did not exist:

```sh
bun test packages/service/src/__tests__/run-interceptors.test.ts packages/service/src/__tests__/request-transform.test.ts
```

Exit 1: existing tests were `3 pass`; the new module had `1 fail`, `1 error` because `Export named 'beforeRequest' not found`. This export absence was not treated as behavioral RED evidence.

A minimal compiling placeholder then exported the exact synchronous callback contract and returned `(_req, _ctx, next) => next()`, without normalization or exception adaptation. The same command was rerun:

```sh
bun test packages/service/src/__tests__/run-interceptors.test.ts packages/service/src/__tests__/request-transform.test.ts
```

Exit 1: `3 pass`, `6 fail`, `11 expect() calls`, `9 tests across 2 files`, with no unhandled error between tests. All six new tests failed behaviorally:

1. Original request normalization: `expect(req.payload).not.toBe(originalPayload)` failed because the original `{ value: 1 }` payload had not been replaced.
2. Request-only callback: expected transform call count `1`, received `0`.
3. Normalization throw: expected next call count `0`, received `1`.
4. Reentry: outer interceptor expected first terminal value `2`, received `1`.
5. Synchronous downstream throw: the original `downstream threw` error escaped synchronously instead of becoming a rejected promise.
6. Already-rejected downstream promise: error rejection was consumed successfully, then expected transform call count `1`, received `0`.

Only after this behavioral RED run was the placeholder replaced with the required `try { transform(req); return next() } catch (error) { return Promise.reject(error) }` implementation and the gateway wrapper added.

## GREEN and verification

```sh
bun test packages/service/src/__tests__/run-interceptors.test.ts packages/service/src/__tests__/request-transform.test.ts
```

Exit 0: `9 pass`, `0 fail`, `33 expect() calls`, `9 tests across 2 files`.

```sh
bun run --filter '@vibe-core/service' typecheck
```

Exit 0: `@vibe-core/service typecheck: Exited with code 0`. This includes the test file's `Assert<T extends true>` checks rejecting both `() => Promise<undefined>` and `() => void`, while accepting `(req: Req) => undefined`, without suppression directives.

```sh
bun run --filter '@vibe-llm/gateway' typecheck
```

Exit 0: `@vibe-llm/gateway typecheck: Exited with code 0`.

```sh
bun run scripts/check-framework-purity.ts
```

Exit 0: `[framework-purity] OK`.

```sh
bunx --no-install eslint packages/service/src/index.ts packages/service/src/request-transform.ts packages/service/src/__tests__/request-transform.test.ts packages/gateway/src/data-plane/chat-flow/shared/request-normalization.ts
```

Exit 0, no lint errors or file diagnostics. The existing TypeScript import resolver emitted this performance advisory: `Multiple projects found, consider using a single tsconfig with references to speed up, or use noWarnOnMultipleProjects to suppress this warning`.

From the worktree root:

```sh
git diff --check
git diff --cached --name-only
git add vnext/packages/service/src/request-transform.ts vnext/packages/service/src/index.ts vnext/packages/service/src/__tests__/request-transform.test.ts vnext/packages/gateway/src/data-plane/chat-flow/shared/request-normalization.ts
git diff --cached --stat
git diff --cached --check
git commit -m 'refactor(vnext): define synchronous request normalization contracts'
git show --format=fuller --stat HEAD
git status --short
```

All exited 0. The initial cached-name query was empty. The cached stat and final commit show exactly the four scoped files. Both whitespace checks had no output. The post-commit status retained all ten modified and four untracked protected overlay files, plus the controller's untracked research directory, with no remaining uncommitted Task 1 helper/test changes.

## Self-review

- The transform is invoked synchronously with the original request reference and exactly one runtime argument; no context or next callback is exposed to it.
- Normalization completes before the single `next()` call on each entry. A thrown transform invokes next zero times and retains the original error as the rejection reason.
- No success-path async wrapper or await exists in either new production helper. Direct identity checks prove the terminal resolved and already-rejected promises are returned unchanged.
- A synchronous downstream throw is caught and converted to a rejected promise, retaining the original error identity.
- Real `runInterceptors` composition verifies two outer next calls normalize twice, observing the initial payload and then a replacement payload, with exactly two terminal calls and ordered values `[2, 11]`.
- The service file imports `Interceptor` using the required type-only `./index` import, so the export relationship introduces no runtime import cycle.
- The gateway normalizer has only payload and enabledFlags in its parameter surface while structural typing permits passing the same full Invocation directly to the generic adapter.
- Mutation review: omitting transform, moving it after next, cloning the request, exposing extra arguments, adding an async wrapper, delegating twice, bypassing catch, or skipping reentry normalization would violate tested behavior. Widening the transform return type to void or a promise would violate the type assertions.
- No unresolved implementation concerns were found. The lint resolver advisory is informational. Full monorepo CI, SDK integration, build, and deployment were not run for this isolated helper slice; the requested focused checks all passed, and no claim is made about those broader checks or production migrations.

## Protected-overlay hash preservation

This exact command was run from the worktree root before implementation, after verification/self-review, and after commit:

```sh
python3 - <<'PY'
import hashlib,json,pathlib
root=pathlib.Path('.')
manifest=json.loads((root/'.superpowers/sdd/2026-10-01-interceptor-contracts/isolated-protected-files.json').read_text())
for name,expected in manifest.items():
    actual=hashlib.sha256((root/name).read_bytes()).hexdigest()
    print(('MATCH' if actual==expected else 'MISMATCH'), name, actual)
assert all(hashlib.sha256((root/name).read_bytes()).hexdigest()==expected for name,expected in manifest.items())
print(f'All {len(manifest)} protected files match.')
PY
```

Every run exited 0 and printed `All 14 protected files match.` The post-commit hash values were:

| Protected file | SHA-256 |
| --- | --- |
| `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-responses-collaboration-shim.ts` | `16136a27d4d74b58971c5f20f9b32ef926ce24cbdad17ca1a66ddc66df200349` |
| `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/collaboration-shim.test.ts` | `9fb36007e8448edfa3ec58189778140b068868a1f5bd6108d4b628c09e4bd641` |
| `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/producer-domain-collaboration.test.ts` | `753a889252bff4cb268750523753750d23c987d49c33d4410cb7660ad3026c95` |
| `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/with-responses-collaboration-shim.test.ts` | `d7de8bc62f8609d45cf1c76c463e741ddac7e1eef11621334b54c8cb4013bcb0` |
| `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts` | `b1251d63baf1fffe431d32577201171e93542e0b12f9df07ade22cdb994a1fad` |
| `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/index.ts` | `ef4e2110e0ff7989b42458227d227da6902f06354a9f96afe43643761d809ec6` |
| `vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts` | `0c0e5eeba1b4bd6915e393a2d80771d5e3c2960647d234c68a39fdd7bb185513` |
| `vnext/packages/gateway/tests/data-plane/chat-flow/responses/attempt.test.ts` | `7edc7c5193369bad28e2a4a5006169211b00caea5275bf60392c3e17441dbadc` |
| `vnext/packages/protocols-llm/src/flags/index.ts` | `6aea18abea181d1960fd7ed69712978ae6754a8bbdbb7b4e489c6bba7459ae33` |
| `vnext/packages/protocols-llm/src/responses/__tests__/stream.test.ts` | `6ef365a6e7a6702f909681cad80bc1fa98cd5dc57cc87d52da253ea43610e40b` |
| `vnext/packages/protocols-llm/src/responses/events.ts` | `53776e65170c846367ef2869ca67f904f6f7ea0d6d592bf870276a1fbf453f5c` |
| `vnext/packages/protocols-llm/src/responses/from-result.ts` | `cb29a9162eae014ad49b20b9443c11ac3c3cb42674701c6da05c08b7381ae291` |
| `vnext/packages/protocols-llm/src/responses/index.ts` | `205d3940f08db4d47ec25dfa9d834d945667db09640875003c863da317c2e11c` |
| `vnext/packages/protocols-llm/src/responses/stream.ts` | `1a61cc698caa9655edf4311501fb1c7e513845f0fd5dec4ee2e3e7ea331a9af0` |
