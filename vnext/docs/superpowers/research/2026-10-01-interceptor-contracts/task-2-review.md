# Task 2 review

## Spec Compliance

- ✅ Spec compliant. The packaged `c1acacea816278d91ebcd9e4824a860857f61331..4b8afdad92fccff28ccc29614e0a7ad5fdc21c2c` diff contains exactly the 21 required leaf migrations and the new 203-line composition test. Each module retains its exported interceptor name and protocol interceptor annotation, constructs `withRequestNormalization` at module initialization, removes only downstream delegation, and uses synchronous payload/flags callbacks. No new `any`, suppression, non-null assertion, schema, flag, environment variable, retry, or lifecycle owner is added.
- ✅ Every listed leaf was checked individually against its original diff body. Transformation expressions, gates, field values, replacement versus mutation behavior, and helper exports are unchanged. The table below records the individual evidence; source paths are relative to `vnext/packages/gateway/src/data-plane/chat-flow/`.

| Leaf evidence | Verified preserved behavior |
| --- | --- |
| `responses/interceptors/with-empty-tools-tool-choice-none.ts:4` | Flag plus empty-array gate; replacement uses string `tool_choice: 'none'`. |
| `responses/interceptors/with-reasoning-disabled-on-forced-tool-choice.ts:28` | Existing forced-choice helper and flag; replacement uses `reasoning: { effort: 'none' }`. |
| `responses/interceptors/with-role-compatibility-applied.ts:21` | Existing three role flags, post-promotion ordering, and message-only rewrite. |
| `responses/interceptors/with-prompt-cache-key-stripped.ts:11` | Flag and undefined guards; destructuring removes only the cache key. |
| `responses/interceptors/with-image-generation-tool-injected.ts:34` | Opt-in gate, `tool_choice === 'none'` exclusion, duplicate hosted-tool check, and appended declaration. |
| `responses/interceptors/with-vendor-deepseek-normalized.ts:22` | Vendor gate and canonical sentinel removal; existing disabled-thinking wire shape. |
| `responses/interceptors/with-vendor-qwen-normalized.ts:17` | Vendor gate and canonical sentinel removal; `enable_thinking: false`. |
| `messages/interceptors/with-empty-tools-tool-choice-none.ts:4` | Flag plus empty-array gate; replacement uses `{ type: 'none' }`. |
| `messages/interceptors/with-reasoning-disabled-on-forced-tool-choice.ts:38` | Existing `tool`/`any` detection and helper; thinking disabled, effort stripped, remaining output configuration retained. |
| `messages/interceptors/with-role-compatibility-applied.ts:21` | Existing interleaved-system flag and system-to-user mapping. |
| `messages/interceptors/with-billing-attribution-stripped.ts:50` | Existing flag, regexes, string/block processing, and removal of empty system content. |
| `messages/interceptors/with-eager-input-streaming-stripped.ts:23` | Existing flag and array gate; object tools lose only the eager-streaming field, other entries survive. |
| `chat-completions/interceptors/with-empty-tools-tool-choice-none.ts:4` | Flag plus empty-array gate; replacement uses string `tool_choice: 'none'`. |
| `chat-completions/interceptors/include-usage-stream-options.ts:20` | Streaming-only guard; existing stream options retained while `include_usage` becomes true. |
| `chat-completions/interceptors/with-reasoning-disabled-on-forced-tool-choice.ts:28` | Existing forced-choice helper and flag; canonical `reasoning_effort: 'none'`. |
| `chat-completions/interceptors/with-role-compatibility-applied.ts:25` | Existing three role gates and leading-system-run tracking after promote/demote. |
| `chat-completions/interceptors/with-prompt-cache-key-stripped.ts:12` | Flag and undefined guards; replacement removes only the cache key. |
| `chat-completions/interceptors/with-vendor-qwen-normalized.ts:13` | Vendor gate and canonical sentinel removal; `enable_thinking: false`. |
| `gemini/interceptors/strip-unsupported-part-fields.ts:48` | Existing exported payload helper is called directly; no helper/filter change. |
| `gemini/interceptors/strip-unsupported-tools.ts:67` | Existing exported payload helper is called directly; search-preservation logic is not replaced. |
| `gemini/interceptors/strip-safety-settings.ts:12` | Same in-place deletion of `safetySettings`; only input identifier changes from `ctx` to `inv`. |

- ✅ `vnext/packages/gateway/tests/data-plane/chat-flow/shared/request-normalization.test.ts:11` imports the actual four registry arrays. Its recording terminal returns a native event result with an empty iterator (`:30`), avoiding a fabricated result guard shape. Responses/Chat forced-choice plus Qwen expectations remove the canonical sentinel (`:44`, `:54`); empty-tools cases preserve reasoning across Responses, Chat, and Messages (`:64`, `:75`, `:84`).
- ✅ The outer fixture replaces the payload on the same Invocation, invokes downstream twice, and verifies terminal/reentry payload identity (`vnext/packages/gateway/tests/data-plane/chat-flow/shared/request-normalization.test.ts:97`). The Responses/Chat fixtures assert distinct model, content, cache-key removal, role normalization, and forced-choice translation on both turns (`:134`, `:156`). The fixture owns no hosted-tool implementation. Gemini's integration assertion retains both search declaration spellings while stripping unsupported fields (`:178`), and the final adapter test verifies replacement reaches the original Invocation's terminal (`:196`).
- ⚠️ Cannot independently verify all original protected-overlay bytes from this task diff. They do not appear in the 22-file diff, and the controller separately confirmed matching all 38 main and 14 isolated protected hashes in its review message. That controller evidence resolves the preservation gate; this report does not claim an independent hash comparison.
- ⚠️ Final frozen-artifact `ci:local` qualification and combined integration review are outside Task 2 and have not been established by its focused logs. The controller must complete the prescribed qualification before final branch completion. This is not a missing Task 2 implementation requirement.

## Strengths

- The migration is narrow and mechanically reviewable: the leaf bodies retain existing mutations/replacements, while each wrapper receives only the typed payload/flags interface. No runtime view is allocated (`vnext/packages/gateway/src/data-plane/chat-flow/shared/request-normalization.ts:5`, `:11`).
- Composition assertions test observable outgoing payloads and reference identity through actual registry arrays, including two-turn reentry, rather than merely asserting an expected list of functions (`vnext/packages/gateway/tests/data-plane/chat-flow/shared/request-normalization.test.ts:30`, `:97`).
- The scoped change preserves image declaration versus hosted-loop ownership. Actual Responses registration keeps image injection before the existing server-tool shim, with empty-tools/role/reasoning/vendor normalization downstream (`vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/index.ts:74`). No attempt, provider, registry, or stream/tool owner is changed by this diff.

## Issues

### Critical (Must Fix)

- None found.

### Important (Should Fix)

- None found.

### Minor (Nice to Have)

- `.superpowers/sdd/2026-10-01-interceptor-contracts/task-2-lint.log:1`: Scoped ESLint emits the existing multiple-tsconfig resolver advisory. It does not identify a migrated source defect or invalidate the reported exit code, but the verification output is not pristine. Track resolver configuration cleanup separately if desired; no unrelated configuration change is required for this task.

## Focused cross-task checks and validation evidence

- Named risk: narrowing input might introduce a copied/stale Invocation, asynchronous transform authority, or extra successful-delegation promises. Checked the unchanged Task 1 gateway wrapper and its service implementation: `RequestNormalizationInput` exposes only payload/flags (`vnext/packages/gateway/src/data-plane/chat-flow/shared/request-normalization.ts:5`), `RequestTransform` returns `undefined` (`vnext/packages/service/src/request-transform.ts:3`), and the service passes the original request directly to the transform and returns `next()` directly (`:10`, `:11`). Its catch converts a synchronous transform/downstream throw into a rejected promise (`:12`). The service runner retains shared Invocation and downstream reentry (`vnext/packages/service/src/index.ts:33`). Successful delegation adds one synchronous transform call and no new promise; this does not establish a CPU, latency, or heap improvement.
- Named risk: a correct leaf migration could still compose incorrectly around hosted loops or provider-specific translation. Checked the four unchanged registry arrays only: Responses preserves injection before hosted shim, empty-tools before forced-reasoning, and vendor normalization last (`vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/index.ts:70`); Chat preserves empty-tools before forced-reasoning and Qwen after it (`vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/index.ts:57`); Messages preserves web-search placement and empty-tools before forced-reasoning (`vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/index.ts:49`); Gemini retains its cleanup order and existing thought suppression (`vnext/packages/gateway/src/data-plane/chat-flow/gemini/interceptors/index.ts:20`). Original byte preservation is covered by the controller evidence noted above, rather than inferred from this source inspection.
- Recorded affected-suite log inspected, not rerun: `.superpowers/sdd/2026-10-01-interceptor-contracts/task-2-tests.log:153` records all nine new cases passing; `:557` records 457 pass, 0 fail, 1266 assertions across 48 files. Search of the log found only passing test titles containing error/failure terms, with no unexpected warning/failure output.
- Recorded package typechecks and purity inspected, not rerun: `.superpowers/sdd/2026-10-01-interceptor-contracts/task-2-typecheck.log:1` and `:2` record service/gateway exit 0; `task-2-purity.log:1` records framework purity OK. Scoped lint has only the Minor advisory above.
- Read the diff in one review pass; the initial tool output truncated a middle segment, which was recovered by bounded reads of that omitted segment. No changed source file was separately reread for judgment. Line-reference indexing used the packaged diff. No Git commands, test reruns, deployments, dependency installation, service restarts, or source/index mutations were performed. The only written file is this review report.

## Assessment

**Task quality:** Approved.

**Reasoning:** All 21 migrations preserve the original transform rules and narrow their authority without moving registry or lifecycle ownership. The actual-registry composition and identity tests address the main ordering/reentry risks; the recorded focused checks pass, with only a pre-existing tooling advisory and controller-owned final qualification remaining.
