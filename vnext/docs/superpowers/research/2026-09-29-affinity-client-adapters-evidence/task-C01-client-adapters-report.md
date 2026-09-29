# C01 Chat/Gemini client adapters

Status: implementation starting on accepted b8e47a736d7c9471b44be6cef8bf7127ce8de2bd; sole product writer in reference-adoption-verify.

## Interface approach recorded before implementation

Extend the existing AffinityProtocol/analysis/stamp API with chat_completions and gemini source domains. Chat binds canonical reasoning text (including explicit empty canonical values); removal projects the complete reasoning fields and rejects tool-adjacent unsafe history. Gemini binds complete semantic Part minus thoughtSignature, without array indexes; signed function/non-text state is required and rejected before provider calls when current hubs cannot represent it. Existing source context, lazy codec, actual execution capture and inference fence flow through the active selectors/attempts/responders. No new global state or provider.

Source egress uses the existing AffinityEgress ownership, with per-choice Chat accumulation and complete Gemini Parts. Raw signature fragments are accumulated before one source stamp; no gateway carrier concatenation. Preserve source metadata, whitespace, terminal ordering and arbitrary tool argument objects. Existing hub entrance guards bound raw buffers before translation; native Chat gets equivalent bounds. Translators carry raw opaque and full companion only, never reinterpret source envelopes. Multiple source states that cannot map to one Chat slot reject instead of guessing concatenation. Gemini thought suppression removes the complete thought Part including its signature.

Tests-first: add protocol analysis/egress/translation regression fixtures, run red, implement, then focused affinity/translation/data-plane tests, package typechecks and owned-file lint. Root owns independent actual HTTP/SDK acceptance and full CI. No commits, deployment, live config or subagents.

## Delivered behavior and explicit representation policy

- Source-owned `chat_completions` and `gemini` analysis domains authenticate once after routing policy resolution. Chat binds `chatReasoningText` canonical precedence, including empty canonical values. Gemini binds every field of the semantic Part except thoughtSignature, sorted canonically, without array indexes. Recognized user-role replays reject. Tool business argument properties are untouched.
- Active Chat and Gemini selectors carry the existing request context, preparation options, source controls and selected/actual target fence through hub recursion. Fresh source materialization happens before translation/interceptors. Affinity routing-unavailable exceptions become structured 503 execution results, matching the accepted Messages path. Providers, owner scope, declaration shape, persistence secret initialization and codec are unchanged.
- Optional Chat degradation removes all reasoning aliases/items and the opaque field together; empty assistant messages are removed. Tool-adjacent unsafe Chat/Gemini projections reject. Optional Gemini thought removal deletes the whole Part and emptied model content. Signed function/non-text Parts are required. Existing Gemini hubs cannot represent those required source states, so authenticated instances reject with routing-unavailable before provider preparation/inference. No native Gemini upstream was added.
- Chat egress tracks each choice separately. JSON reassembly now preserves independent choices rather than merging their text/tool arguments/metadata. Egress buffers reasoning text and raw signature fragments until that choice finishes, then emits one complete canonical reasoning_text plus one authenticated carrier, in the finish choice. Ordinary content remains streaming. This necessary delay is explicit: OpenAI 6.33.0 finalChatCompletion assigns unknown extension fields rather than concatenating reasoning_text. Emitting earlier thought fragments would produce an invalid next-turn companion. No opaque field means no invented opaque marker; unsigned reasoning is still preserved. Unterminated buffered reasoning is rejected before [DONE].
- Gemini emits a complete thought Part containing the entire whitespace-preserved thought and its signature exactly once. It does not put a signature-only tail after earlier thought fragments. Candidate indexes and function call IDs/name/args survive the Chat and Messages bridges. Thought suppression now applies the same whole-Part rule to JSON and SSE.
- Chat↔Messages/Responses translators preserve raw opaque and full whitespace on ingress/body/events. Responses terminal-only reasoning output is also carried. Messages initial-only tool inputs survive SSE mapping, while subsequent argument deltas take precedence; arbitrary nested business names such as signature, encrypted_content and fingerprint remain ordinary JSON.
- Explicit safe rejection: redacted_thinking cannot map to a Chat reasoning signature without losing its native type, and multiple independent signed reasoning blocks cannot map to one Chat slot. Gemini→Chat/Messages rejects multiple signatures or a signed thought combined with another thought in the same Content. Foreign signatures remain raw for representable thought Parts; non-thought/signed function Parts cannot be represented by the available hubs and reject rather than disappearing. Root accepted conservative typed rejection for nonrepresentable state.
- Native Responses compaction aliases, program/program_output state, and direct agent_message encrypted_content output slots reject for Chat/Gemini sources, including added/done and terminal-only response envelopes. A shared translator check visits only protocol slots. The guard invokes it only for these new source protocols; accepted Responses/Messages source behavior is unchanged.
- The active selector excludes Chat dialect candidates whose existing interceptors explicitly discard opaque signatures (`reasoning-content-dialect`, `vendor-deepseek`) for owned input. It must not call such a path as an apparently exact compatible execution and silently retain detached reasoning text.
- Upstream framing guards bound native Chat reasoning/signature buffers before translation and JSON reassembly. Existing transport cancellation owns socket abort; no second cancellation model was introduced.

## Tests first and verification

All product commands ran in `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify`, or its `vnext/` subdirectory as indicated. Initial clean HEAD was exactly `b8e47a736d7c9471b44be6cef8bf7127ce8de2bd`.

Initial RED logs:

- `/tmp/c01-client-red.log`: Chat/Gemini carrier absent, 0 pass / 2 fail.
- `/tmp/c01-client-red2.log`: missing Chat egress, missing opaque mappings, split Gemini Parts, 2 pass / 3 fail.
- `/tmp/c01-client-red3.log`: Gemini Messages signature/ID mapping missing.
- `/tmp/c01-client-red4.log` and `red5.log`: initial-only tool arguments missing, user-role owned replay accepted, redacted state incorrectly flattened, split dialect text lost.
- `/tmp/c01-client-red6.log`: native SDK aggregation companion split and DONE emitted before pending opaque rejection.
- `/tmp/c01-client-red7.log`: source routing error escaped and required output silently lost.
- `/tmp/c01-client-red8.log`: terminal-only reasoning dropped and signed Gemini thought flattened with another thought.
- `/tmp/c01-client-red9.log`: non-thought foreign signature silently projected into a different kind.
- `/tmp/c01-client-red10.log`: lossy Chat dialect candidate still selected.

Final focused suite (from `vnext/`):

```sh
bun test packages/gateway/tests/affinity packages/translate \
  packages/gateway/tests/data-plane/chat-flow \
  packages/gateway/tests/integration/cross-protocol-gemini-to-cc.test.ts \
  packages/gateway/tests/integration/cross-protocol-gemini-to-responses.test.ts \
  packages/gateway/tests/integration/gemini-telemetry.test.ts \
  packages/gateway/tests/integration/chat-completions-telemetry.test.ts
```

Final result: **1091 pass, 0 fail, 3166 assertions, 121 files**, `/tmp/c01-client-regression-final.log`. The new `client-adapters.test.ts` contains 20 focused cases. No tests were changed merely to match an implementation; one new tool-input assertion was narrowed to ignore existing cache_control metadata while still asserting complete input/id/name preservation. The earlier flow run exposed a suppression wrapper replacing a non-Gemini test body with an empty candidate envelope; this was fixed to leave unknown body shapes unchanged, and the unchanged existing test passes.

Final typechecks (from `vnext/`):

```sh
bun run --filter '@vibe-llm/gateway' --filter '@vibe-llm/translate' typecheck
```

Both exited 0, `/tmp/c01-client-final-types.log`.

Final lint (from `vnext/`, all owned TypeScript paths):

```sh
bunx eslint $(git diff --name-only -- '*.ts' | sed 's|^vnext/||') \
  packages/gateway/tests/affinity/client-adapters.test.ts \
  packages/translate/src/shared/client-opaque-state.ts
```

Exited 0 with no lint errors or warnings, `/tmp/c01-client-final-lint.log`. The resolver prints only its multiple-project performance advisory. `git diff --check` passed after removing one introduced whitespace-only line. Full CI was intentionally left to root as assigned.

## Independent diagnostics reported by root (not agent-run frozen acceptance)

Root's mutable actual authenticated Bun/SQLite suite passed 20 groups / 52 inference calls, with official Google GenAI **2.24.0** history/replay across all three hubs. Root's mutable workerd/D1 suite passed 12 routes / 24 inference calls. Independent Node-upstream overflow/cancellation checks passed eight cases and stopped upstream at 9/40 chunks with socket closure and error metrics. Root's edge suite passed 23 groups, including official OpenAI **6.33.0** stream aggregation/replay, multiple Gemini candidates, thought suppression, role checks, foreign state and required zero-inference rejection. Eight actual unsupported-output groups passed after the native continuation checks.

Those mutable results are root-owned and require the planned frozen reruns. Exact root logs include `/tmp/vnext-c01-client-adapters-mutable2.log`, `-d1-mutable2.log`, `-edge-mutable3.log`, and `-unsupported-mutable3.log`. This report does not claim every third-party Gemini client works. Root retains final review, full CI, old Responses/Messages/Codex/runtime regressions, warm zero-SQL and frozen SDK/HTTP/SQLite/D1 acceptance.

## Freeze — DONE

Product writes are stopped. **28 owned repository-relative paths** are listed in `task-C01-client-adapters-owned.json`, with exact content hashes in `task-C01-client-adapters-frozen-sha256.json`. These owned paths are this slice, from the verified clean accepted base; root subsequently added its separately owned evidence directory under vnext/docs/superpowers/research, which is excluded from this manifest. No commits, push, deployments, live configurations, account/session changes, subagents, stash operations or worktree cleanup occurred. Overall C01 completion remains root's acceptance decision.


## Review fix round 1 — DONE / FROZEN

Both Important findings in `task-C01-client-adapters-review.md` were reproduced with tests before changing product code. This round changes exactly three existing owned paths: `vnext/packages/gateway/src/shared/affinity/analysis.ts`, `vnext/packages/translate/src/shared/client-opaque-state.ts`, and `vnext/packages/gateway/tests/affinity/client-adapters.test.ts`. The other 25 owned paths still match the initial freeze. The initial snapshot remains in `task-C01-client-adapters-fix1-base`; the owned manifest remains unchanged at 28 paths.

- Optional Chat projection now removes a message only when stripping reasoning leaves a bare role and absent/null/empty text content. Every additional accepted field is retained, including refusal, audio, legacy function_call, and unknown extension payloads with object, false, or null values. No new payload allowlist is used. Pure reasoning-only messages still disappear; exact materialization and the source input remain unchanged.
- Native Responses `program_output` rejects by recognized item type regardless of absent encrypted_content/fingerprint. The existing checks remain confined to protocol item slots and response output arrays. JSON and streaming Chat/Gemini adapters, added/done items, all supported envelope stages (including terminal-only completed/incomplete/failed), and gateway frame guards are covered. Tool business JSON carrying the same type at its top level or nested remains preserved through JSON/SSE and passes the guard.

Commands below ran from `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify/vnext`:

```sh
bun test packages/gateway/tests/affinity/client-adapters.test.ts
```

Before product edits: **22 pass, 14 fail, 89 assertions**, `/tmp/c01-client-fix1-red.log`. Failures reproduce six non-reasoning payload losses and eight native program_output rejection gaps. After product edits: **36 pass, 0 fail, 123 assertions**, `/tmp/c01-client-fix1-green.log`.

```sh
bun test packages/gateway/tests/affinity packages/translate packages/gateway/tests/data-plane/chat-flow packages/gateway/tests/integration/cross-protocol-gemini-to-cc.test.ts packages/gateway/tests/integration/cross-protocol-gemini-to-responses.test.ts packages/gateway/tests/integration/gemini-telemetry.test.ts packages/gateway/tests/integration/chat-completions-telemetry.test.ts
bun run --filter '@vibe-llm/gateway' --filter '@vibe-llm/translate' typecheck
bunx eslint packages/gateway/src/shared/affinity/analysis.ts packages/translate/src/shared/client-opaque-state.ts packages/gateway/tests/affinity/client-adapters.test.ts
```

Regression: **1107 pass, 0 fail, 3232 assertions, 121 files**, exit 0, `/tmp/c01-client-fix1-regression.log`. Both package typechecks exit 0, `/tmp/c01-client-fix1-types.log`. Lint exits 0 with no errors or warnings; only the existing multiple-project resolver advisory, `/tmp/c01-client-fix1-lint.log`. `git diff --check` passes. HEAD remains `b8e47a736d7c9471b44be6cef8bf7127ce8de2bd`.

Root separately reported five actual HTTP mutable groups passing for refusal preservation and Chat/Gemini JSON/SSE program_output typed rejection in `/tmp/vnext-c01-client-adapters-review-fix1-mutable.log`; this is root-reported evidence, not an implementer-run runtime check. Root retains full CI, frozen runtime reruns, and scoped review.

Product writes are stopped again. `task-C01-client-adapters-frozen-sha256.json` has been refreshed for all 28 owned paths. No subagents, commits, push, deploy, live configuration changes, stash operations, or cleanup occurred during this round.
