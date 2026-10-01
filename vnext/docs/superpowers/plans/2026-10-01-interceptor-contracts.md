# Synchronous Request Normalization Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement and review this plan task-by-task. Check deliverables only after their evidence exists.

**Goal:** Separate synchronous request corrections from around-interceptors while preserving all current chain behavior.

**Architecture:** A domain-neutral synchronous transform adapter owns one downstream delegation. A gateway wrapper narrows mutation authority to payload and flags. Twenty-one existing corrections adopt it in their current chain positions; tools and output adapters keep their existing owners.

**Tech Stack:** Strict TypeScript, Bun, existing service and gateway packages.

**Spec:** [Interceptor contracts](../specs/2026-10-01-interceptor-contracts.md).

## Global Constraints

- Reuse `.worktrees/cfw-resource-rollback-fix` and installed dependencies. No push, CFW deployment, Docker replacement, service restart, dependency installation or production access.
- Preserve all original tracked/untracked overlay bytes. None of the 14 isolated protected paths needs modification; do not stage them.
- Preserve chain order, tool-loop reentry, native JSON, producer-domain checks, provider placement, flags, payload rules, quota/history ordering, Responses continuation and cleanup authority.
- Keep the service package domain-neutral and the gateway wrapper typed. No `any`, suppression directives or new non-null assertions. Source/docs remain English; user updates Chinese.
- Construct adapter closures once when modules initialize. Each chain entry adds one synchronous function call; successful delegation creates no extra promise or per-frame work. These mechanisms do not prove a CPU/latency/heap improvement.
- No new schemas, environment variables, feature flags, retry policies or lifecycle owners.
- Use focused validation during implementation and one final `ci:local` qualification of the frozen artifact. Do not run benchmarks in this slice.

## Task 1: Enforce synchronous normalization and single delegation

**Files:**
- Create `vnext/packages/service/src/request-transform.ts`.
- Modify `vnext/packages/service/src/index.ts` only to export the new contract/helper.
- Create `vnext/packages/service/src/__tests__/request-transform.test.ts`.
- Create `vnext/packages/gateway/src/data-plane/chat-flow/shared/request-normalization.ts`.

**Interfaces:**
- `RequestTransform<Req> = (req: Req) => undefined`.
- `beforeRequest<Ctx, Req, Result>(transform: RequestTransform<Req>): Interceptor<Ctx, Req, Result>`.
- `RequestNormalizationInput = Pick<Invocation, "payload" | "enabledFlags">`.
- `LlmRequestNormalizer = RequestTransform<RequestNormalizationInput>`.
- `withRequestNormalization<TResult>(normalize: LlmRequestNormalizer): LlmInterceptor<TResult>` delegates with `<RequestContext, Invocation, TResult>`.

- [x] **Add the focused failing behavioral tests and type assertions.** Test normalization before downstream invocation, original request/payload replacement, exactly one next per entry, zero next on thrown normalization, and original rejection identity. A representative test is:

```ts
const req = { payload: { value: 1 } }
const terminalPromise = Promise.resolve({ ok: true })
let nextCalls = 0
const interceptor = beforeRequest<{}, typeof req, { ok: boolean }>((current) => {
  expect(current).toBe(req)
  current.payload = { value: current.payload.value + 1 }
})
const output = interceptor(req, {}, () => {
  nextCalls++
  expect(req.payload.value).toBe(2)
  return terminalPromise
})
expect(nextCalls).toBe(1)
expect(output).toBe(terminalPromise)
expect(await output).toBe(await terminalPromise)
```

Use a non-empty test context type if lint rejects `{}`. Add type-level `Assert<T extends true>` checks inside this service test file (included by its tsconfig): `(() => Promise<undefined>) extends RequestTransform<Req>` and `(() => void) extends RequestTransform<Req>` must be false; a synchronous undefined callback must be accepted. Do not use suppression directives. New-export absence may initially prevent execution; once a minimal placeholder exists, observe a behavioral failure before implementing the adapter.

- [x] **Implement the contract with no success-path async wrapper.** Preserve the exact request reference and catch synchronous exceptions as rejected promises:

```ts
return (req, _ctx, next) => {
  try {
    transform(req)
    return next()
  } catch (error) {
    return Promise.reject(error)
  }
}
```

Place `import type { Interceptor } from "./index"` in the new service file; the type-only dependency creates no runtime cycle. Gateway uses the existing `LlmInterceptor` alias and exposes only its narrow parameter type while passing the same invocation to the generic adapter.

- [x] **Verify reentry and exception paths.** An outer interceptor calls its `next()` twice with a payload replacement between calls; the transform must see both payloads and terminal must run twice. Cover a synchronous downstream throw and an already-rejected downstream promise, preserving their original errors. Transform gets only the request argument; it does not receive context or next.
- [x] **Run focused tests, service/gateway typechecks, purity and scoped lint.** From `vnext`: `bun test packages/service/src/__tests__/run-interceptors.test.ts packages/service/src/__tests__/request-transform.test.ts`; `bun run --filter '@vibe-core/service' typecheck`; `bun run --filter '@vibe-llm/gateway' typecheck`; `bun run scripts/check-framework-purity.ts`; scoped ESLint on changed files. Fix only issues from this task.
- [x] **Commit scoped helper/tests and write the implementation report.** Use `refactor(vnext): define synchronous request normalization contracts`; include RED/GREEN commands/results, file list, self-review and protected-overlay hash check.

## Task 2: Apply the contract to existing protocol corrections

**Files:** Modify exactly these existing interceptor modules, plus the new integration test listed below:

- Responses: `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-empty-tools-tool-choice-none.ts`, `with-reasoning-disabled-on-forced-tool-choice.ts`, `with-role-compatibility-applied.ts`, `with-prompt-cache-key-stripped.ts`, `with-image-generation-tool-injected.ts`, `with-vendor-deepseek-normalized.ts`, `with-vendor-qwen-normalized.ts` (the last six share the same directory).
- Messages: `vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-empty-tools-tool-choice-none.ts`, `with-reasoning-disabled-on-forced-tool-choice.ts`, `with-role-compatibility-applied.ts`, `with-billing-attribution-stripped.ts`, `with-eager-input-streaming-stripped.ts` (same directory).
- Chat Completions: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-empty-tools-tool-choice-none.ts`, `include-usage-stream-options.ts`, `with-reasoning-disabled-on-forced-tool-choice.ts`, `with-role-compatibility-applied.ts`, `with-prompt-cache-key-stripped.ts`, `with-vendor-qwen-normalized.ts` (same directory).
- Gemini: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/interceptors/strip-unsupported-part-fields.ts`, `strip-unsupported-tools.ts`, `strip-safety-settings.ts` (same directory).
- Create `vnext/packages/gateway/tests/data-plane/chat-flow/shared/request-normalization.test.ts` for composition/identity tests. Existing tests may be extended only for a missing behavioral assertion, not rewritten to accept new payload rules.

**Interfaces:** Consume `withRequestNormalization<TResult>` from `../../shared/request-normalization`; keep each module's existing exported interceptor name and protocol interceptor type. All registries, attempts, provider interceptors and tool/stream adapters remain unchanged.

- [x] **Read the actual transform body before migrating each function.** Confirm it only uses payload/flags, never context, action, headers, next result or async work. Stop and report any discrepancy with the verified list.
- [x] **Migrate all 21 as a single coherent batch.** For example:

```ts
export const withEmptyToolsToolChoiceNone: ResponsesInterceptor = withRequestNormalization((inv) => {
  const payload = inv.payload
  if (inv.enabledFlags.has("empty-tools-tool-choice-none") && Array.isArray(payload.tools) && payload.tools.length === 0) {
    inv.payload = { ...payload, tool_choice: "none" }
  }
})
```

Replace early `return run()` / `return await run()` with synchronous `return` and remove only the final downstream delegation. Preserve all transformation expressions, gates, field values and existing helper exports. In Gemini retain the current search-preservation rules; do not copy the reference's differing filters. No new runtime view objects or per-call adapter construction.

- [x] **Add behavioral composition tests using actual registries.** Use a native event result with an empty iterator or a native JSON result compatible with existing result guards, and a terminal recording the payload. With hosted tools absent, enabled forced-tool reasoning plus Qwen normalization must yield vendor `enable_thinking:false` and remove the canonical sentinel for Responses and Chat Completions. With empty tools and the empty-tools flag, the earlier normalization must neutralize forced choice so reasoning stays unchanged in Responses, Chat and Messages. Use actual registry arrays, not a copied expected function list. Add an outer two-turn orchestration fixture around real normalizers to prove each entry observes and replaces the latest invocation payload. Reuse existing image-injection/hosted-loop fixtures for those boundaries rather than invent another loop implementation.
- [x] **Validate the migration once as a group.** Run the service contract suite; all four interceptor test directories; gateway `tests/interceptors.test.ts`; all four protocol attempt tests; Responses turn-barrier and dump exception ownership tests. Run service/gateway typechecks, purity and scoped ESLint on the changed files. The unchanged collaboration/producer-domain overlay tests are part of this affected run. No benchmarks or full CI yet.
- [x] **Self-review and commit only scoped migrations/tests.** Verify original registry and protected-overlay bytes are unchanged, no callback has `async`/`run`/context access, original payload replacement reaches the terminal, and no tool/stream owner moved. Use `refactor(vnext): narrow protocol request normalizers`. Report the exact files, commands/results and any limitation. Do not claim a speed/memory improvement.

## Qualification and integration

- [x] Independently review each task for specification compliance and quality; resolve findings before downstream work.
- [x] Freeze the final source plus preserved overlay and run `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` once from the isolated `vnext`.
- [x] Complete final combined review and record the reference advantages, role/order map, qualification and remaining increments under `vnext/docs/superpowers/research/2026-10-01-interceptor-contracts/`.
- [x] Fast-forward local `vNext`, compare all qualified source files and the 38 main/14 isolated protected files, preserve the running fixture and evidence, and report local completion without deployment claims.

## Completion record

Both tasks and local integration are complete. Source head: `4b8afdad92fccff28ccc29614e0a7ad5fdc21c2c`. The frozen source plus preserved overlay passed one full local CI: 5,631 pass / 1 skip / 0 fail. See the [qualification record](../research/2026-10-01-interceptor-contracts/qualification.md) and [whole-branch review](../research/2026-10-01-interceptor-contracts/whole-branch-review.md). No push or deployment occurred; resource and release gates remain explicit follow-ups.
