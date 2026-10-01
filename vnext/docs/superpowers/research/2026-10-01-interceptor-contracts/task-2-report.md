# Task 2 report: protocol request normalizers

## Status and exact scope

Completed local implementation and focused verification. Commit: `4b8afdad92fccff28ccc29614e0a7ad5fdc21c2c`

Commit message: `refactor(vnext): narrow protocol request normalizers`

Base: `c1acacea816278d91ebcd9e4824a860857f61331`; branch: `fix/cfw-resource-rollback`.
Worktree: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`.

Exactly 22 committed files: the 21 specified existing leaf modules and one new integration test. Task 1 helpers, registry arrays, attempts, provider interceptors, around interceptors, tool/stream adapters, controller plans/research, and protected overlays were not staged or edited by this task.

- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-empty-tools-tool-choice-none.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-reasoning-disabled-on-forced-tool-choice.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-role-compatibility-applied.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-prompt-cache-key-stripped.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-image-generation-tool-injected.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-vendor-deepseek-normalized.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-vendor-qwen-normalized.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-empty-tools-tool-choice-none.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-reasoning-disabled-on-forced-tool-choice.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-role-compatibility-applied.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-billing-attribution-stripped.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-eager-input-streaming-stripped.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-empty-tools-tool-choice-none.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/include-usage-stream-options.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-reasoning-disabled-on-forced-tool-choice.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-role-compatibility-applied.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-prompt-cache-key-stripped.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-vendor-qwen-normalized.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/gemini/interceptors/strip-unsupported-part-fields.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/gemini/interceptors/strip-unsupported-tools.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/gemini/interceptors/strip-safety-settings.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/shared/request-normalization.test.ts`

## Implementation and behavioral coverage

Each existing interceptor export keeps its original protocol interceptor type and now calls `withRequestNormalization` once at module initialization. Each callback is synchronous and has only the payload/flags input; early downstream delegation becomes `return`, and final downstream delegation is removed. No invocation view object, extra success promise, per-call adapter, per-frame work, new owner, flag, retry, schema, or environment variable is introduced.

All original transformation expressions, conditions, replacements/mutations, helper exports and Gemini search-preservation filters are retained. The only Gemini body rename is `ctx.payload` to `inv.payload` to identify the narrow invocation input correctly.

The new test uses actual Responses, Chat Completions, Messages and Gemini registries with native event results backed by empty iterators. It verifies:

- Forced-tool reasoning runs before Qwen vendor normalization, and the canonical sentinel is removed (Responses and Chat).
- Empty-tools correction neutralizes forced choice before reasoning disabling (Responses, Chat and Messages); Messages thinking/output effort and format survive.
- An outer two-turn fixture replaces the same Invocation payload before each entry; real Responses/Chat registries observe the latest model, content, cache key and forced choice, and terminal dispatch receives each replacement.
- Real Gemini registry removes unsupported fields while retaining both Google search declaration spellings.
- Gateway wrapper payload replacement reaches the terminal on the original Invocation.

The outer fixture only exercises reentry. Existing image-injection and hosted-loop tests remain the source of coverage for those ownership/activation boundaries and were included in the grouped run.

## Verification commands and results

Commands ran from `F/vnext` unless stated otherwise. Logs are next to this report.

1. Pre-migration characterization baseline:

```sh
bun test packages/gateway/tests/data-plane/chat-flow/shared/request-normalization.test.ts
```

Result: exit 0, 9 pass, 0 fail, 42 assertions. This is intentional existing-behavior characterization, not a claimed RED or a fabricated behavior change. An initial test authoring path accidentally used `vnext/vnext`; that temporary directory was removed and the same test was rerun at its correct path before production edits.

2. One grouped affected-suite run after migration:

```sh
bun test packages/service/src/__tests__ packages/gateway/tests/data-plane/chat-flow/shared/request-normalization.test.ts packages/gateway/tests/data-plane/chat-flow/shared/producer-domain.test.ts packages/gateway/tests/data-plane/chat-flow/responses/interceptors packages/gateway/tests/data-plane/chat-flow/messages/interceptors packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors packages/gateway/tests/data-plane/chat-flow/gemini/interceptors packages/gateway/tests/interceptors.test.ts packages/gateway/tests/data-plane/chat-flow/responses/attempt.test.ts packages/gateway/tests/data-plane/chat-flow/responses/attempt.cross.test.ts packages/gateway/tests/data-plane/chat-flow/messages/attempt.test.ts packages/gateway/tests/data-plane/chat-flow/messages/attempt.cross.test.ts packages/gateway/tests/data-plane/chat-flow/chat-completions/attempt.test.ts packages/gateway/tests/data-plane/chat-flow/chat-completions/attempt.cross.test.ts packages/gateway/tests/data-plane/chat-flow/gemini/attempt.test.ts packages/gateway/tests/data-plane/chat-flow/gemini/attempt.cross.test.ts packages/gateway/tests/data-plane/chat-flow/responses/turn-barrier.test.ts packages/gateway/tests/dump-exception-ownership.sqlite.test.ts
```

Result: exit 0, **457 pass / 0 fail**, 48 files, 1266 assertions. Includes service contract suites, all four interceptor directories (including protected collaboration/producer-domain tests), gateway chain tests, all four native/cross attempt suites, shared producer-domain, Responses turn-barrier and dump exception ownership. Log: `task-2-tests.log`.

3. Relevant package types:

```sh
bun run --filter @vibe-core/service --filter @vibe-llm/gateway typecheck
```

Result: both packages exit 0. Log: `task-2-typecheck.log`.

4. Framework purity:

```sh
bun run scripts/check-framework-purity.ts
```

Result: exit 0, `[framework-purity] OK`. Log: `task-2-purity.log`.

5. Scoped ESLint:

```sh
bunx --no-install eslint \
  packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-empty-tools-tool-choice-none.ts \
  packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-reasoning-disabled-on-forced-tool-choice.ts \
  packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-role-compatibility-applied.ts \
  packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-prompt-cache-key-stripped.ts \
  packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-image-generation-tool-injected.ts \
  packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-vendor-deepseek-normalized.ts \
  packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-vendor-qwen-normalized.ts \
  packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-empty-tools-tool-choice-none.ts \
  packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-reasoning-disabled-on-forced-tool-choice.ts \
  packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-role-compatibility-applied.ts \
  packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-billing-attribution-stripped.ts \
  packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-eager-input-streaming-stripped.ts \
  packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-empty-tools-tool-choice-none.ts \
  packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/include-usage-stream-options.ts \
  packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-reasoning-disabled-on-forced-tool-choice.ts \
  packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-role-compatibility-applied.ts \
  packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-prompt-cache-key-stripped.ts \
  packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-vendor-qwen-normalized.ts \
  packages/gateway/src/data-plane/chat-flow/gemini/interceptors/strip-unsupported-part-fields.ts \
  packages/gateway/src/data-plane/chat-flow/gemini/interceptors/strip-unsupported-tools.ts \
  packages/gateway/src/data-plane/chat-flow/gemini/interceptors/strip-safety-settings.ts \
  packages/gateway/tests/data-plane/chat-flow/shared/request-normalization.test.ts
```

Executed via Python `subprocess.run` with that exact argument list (not shell interpolation).
Result: exit 0, no lint findings. The existing resolver advisory is unchanged: "Multiple projects found, consider using a single tsconfig with references ...". No configuration changes were made. Log: `task-2-lint.log`.

6. Self-review / preservation / scoped commit checks (from F):

- Python compared every callback against `git show c1acacea...:<path>` after applying only the allowed signature/import/early-exit/delegation substitutions. Exact equality passed for all 21 modules; original helper exports/prefixes were also identical after removing the one new import.
- Each module has one module-level adapter; callback bodies contain no `async`, `await`, `run`, `_ctx`, `_requestCtx`; every `inv.*` access is `payload` or `enabledFlags`.
- `git diff --check` and `git diff --cached --check`: exit 0.
- Staging checked exactly 22 paths against the scoped allowlist before commit. `git show --name-only` after commit matches that same allowlist, and index is empty.
- 14/14 protected file SHA-256 hashes match `isolated-protected-files.json` before editing, after focused verification and after commit. Four protocol registries also match their pre-task SHA-256 hashes.

## Preserved registry hashes

- `vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/index.ts`: `54d21a1df9f56fe8433fe721991a0e67db8fc771922b3f646786c17e3c8947d4`
- `vnext/packages/gateway/src/data-plane/chat-flow/gemini/interceptors/index.ts`: `ee8d8360c4f269bbe6bccafbf4332f9fc174671c9ac9d2f7c6e7e45e00a2180a`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/index.ts`: `ef4e2110e0ff7989b42458227d227da6902f06354a9f96afe43643761d809ec6`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/index.ts`: `c5b2dffee9f6a5c5f7733bc54e0b6b2a44507fcb95c53e5fd679b702074f4193`

## Preserved overlay hashes

- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-responses-collaboration-shim.ts`: `16136a27d4d74b58971c5f20f9b32ef926ce24cbdad17ca1a66ddc66df200349`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/collaboration-shim.test.ts`: `9fb36007e8448edfa3ec58189778140b068868a1f5bd6108d4b628c09e4bd641`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/producer-domain-collaboration.test.ts`: `753a889252bff4cb268750523753750d23c987d49c33d4410cb7660ad3026c95`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/with-responses-collaboration-shim.test.ts`: `d7de8bc62f8609d45cf1c76c463e741ddac7e1eef11621334b54c8cb4013bcb0`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`: `b1251d63baf1fffe431d32577201171e93542e0b12f9df07ade22cdb994a1fad`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/index.ts`: `ef4e2110e0ff7989b42458227d227da6902f06354a9f96afe43643761d809ec6`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts`: `0c0e5eeba1b4bd6915e393a2d80771d5e3c2960647d234c68a39fdd7bb185513`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/attempt.test.ts`: `7edc7c5193369bad28e2a4a5006169211b00caea5275bf60392c3e17441dbadc`
- `vnext/packages/protocols-llm/src/flags/index.ts`: `6aea18abea181d1960fd7ed69712978ae6754a8bbdbb7b4e489c6bba7459ae33`
- `vnext/packages/protocols-llm/src/responses/__tests__/stream.test.ts`: `6ef365a6e7a6702f909681cad80bc1fa98cd5dc57cc87d52da253ea43610e40b`
- `vnext/packages/protocols-llm/src/responses/events.ts`: `53776e65170c846367ef2869ca67f904f6f7ea0d6d592bf870276a1fbf453f5c`
- `vnext/packages/protocols-llm/src/responses/from-result.ts`: `cb29a9162eae014ad49b20b9443c11ac3c3cb42674701c6da05c08b7381ae291`
- `vnext/packages/protocols-llm/src/responses/index.ts`: `205d3940f08db4d47ec25dfa9d834d945667db09640875003c863da317c2e11c`
- `vnext/packages/protocols-llm/src/responses/stream.ts`: `1a61cc698caa9655edf4311501fb1c7e513845f0fd5dec4ee2e3e7ea331a9af0`

## Self-review, concerns and qualification boundary

No specification discrepancy was found while reading the 21 original transform bodies. No Task 1 helper change was needed. Actual registry composition checks preserve early empty-tools normalization and late vendor normalization, and the two-turn checks guard against stale/copy invocation views. Existing attempt and ownership tests protect native/translated result boundaries, Responses continuation and cleanup authority. Registries and all protected overlay bytes remain identical.

No additional non-null assertions, `any`, suppressions, dependencies, schema changes, or unrelated configuration changes were added. No speed/memory improvement is claimed; benchmarks were not run.

No unresolved implementation concern was identified. The resolver advisory is an existing tooling limitation. Full CI, independent task review, combined qualification, documentation/integration and local vNext fast-forward belong to the controller; this task ran only the focused checks required by its brief. No push, deployment, Docker replacement, service restart, production access or dependency installation occurred.
