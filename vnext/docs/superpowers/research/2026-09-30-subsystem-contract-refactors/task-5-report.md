# Task 5 implementation report

## Result

- Added an exhaustive bundled provider declaration using `satisfies Record<UpstreamKind, LlmProviderPlugin>`, followed by a Map lookup constructed from those same explicit object keys. Missing bundled kinds now fail typechecking; plugin metadata cannot silently override the declared registry keys. Unknown persisted kinds, including object prototype property names, still return null before fetcher construction.
- Named and exported `PrepareTemplateResult` from chat-flow-kit, preserving the exact existing response/attempt discriminants and fields. Responses now names its local specialization and declares the return type of its existing `prepareResponses` helper.
- Did not introduce another preparation or execution owner. Generate, compact, and warmup still use the existing preparation/turn flow, with no runtime changes to history expansion, requested-model stamping, model mapping, affinity, quota, or attempt order.
- Added SQLite-backed factory characterization for all six bundled kinds, deferred credentials/no discovery during construction, proxy selection failure before credential validation, unknown persisted kinds, and Copilot request-token fallback.

## Owned files

1. `vnext/packages/gateway/src/data-plane/providers/registry.ts`
2. `vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts`
3. `vnext/packages/chat-flow-kit/src/serve-template.ts`
4. `vnext/packages/chat-flow-kit/src/serve-template.test.ts`
5. `vnext/packages/gateway/tests/provider-factory-contract.sqlite.test.ts` (new)

No Git writes, dependency installation, deployment, service restart, or full CI was performed. Task 4 files and the original overlay were not edited by this task.

## Validation

- Before the type change, annotating the existing preparation test with the named contract produced TS2724 (missing exported `PrepareTemplateResult`) in the kit typecheck. After implementation, both kit and gateway typechecks passed.
- The new factory characterization passed against the pre-refactor registry: 16 pass, 0 fail, 32 assertions. Initial Azure fixture setup was corrected to satisfy its existing required API version and accepted endpoint host; those setup errors were not product regressions.
- After implementation, the focused suite passed: **115 pass, 0 fail, 377 assertions**, across:
  - `packages/chat-flow-kit/src/serve-template.test.ts`
  - `packages/gateway/tests/provider-factory-contract.sqlite.test.ts`
  - `packages/gateway/tests/providers-registry.test.ts`
  - `packages/gateway/tests/providers-registry-proxy.test.ts`
  - `packages/gateway/tests/data-plane/chat-flow/responses/serve.test.ts`
  - `packages/gateway/tests/responses-compact.e2e.test.ts`
  - `packages/gateway/tests/affinity/serve.sqlite.test.ts`
- `bun x tsc --noEmit -p packages/chat-flow-kit/tsconfig.json`: pass.
- `bun x tsc --noEmit -p packages/gateway/tsconfig.json`: pass.
- ESLint for the five owned files: pass, with only the existing multiple-project advisory.
- `git diff --check`: pass.
- Overlay check: 12 of 13 baseline hashes unchanged. `with-responses-collaboration-shim.ts` changed concurrently outside this task's ownership; reported to the integrator rather than restored. None of this task's five owned files are overlay files.

## Bounds

This is a declaration/factory-regression guard, not a performance optimization. No CPU, memory, latency, workerd, or production claims are made. The provider Record guarantees kind coverage; existing plugin behavior and the Map lookup remain authoritative at runtime. No unrelated route capability co-location was introduced because this scope revealed no duplicate preparation decision to remove.
