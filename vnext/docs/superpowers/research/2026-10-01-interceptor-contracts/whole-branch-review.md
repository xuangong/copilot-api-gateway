# Whole-branch review: synchronous request normalization contracts

Date: 2026-10-01.

## Scope and reviewed artifact

- Reviewed the complete three-commit package `c3a365511211f709a19207851317587f250740a7..4b8afdad92fccff28ccc29614e0a7ad5fdc21c2c` against the interceptor-contract specification and implementation plan. The range contains two design documents, the service/gateway adapter, 21 leaf migrations, and contract/composition tests.
- Read the packaged diff in one review pass. Tool output omitted its middle section; bounded reads recovered that section. Adjacent source inspection was limited to concrete type, chain placement, tool reentry, producer/JSON ownership, count-tokens documentation, and lint-configuration risks described below.
- Also reviewed the current research README and the controller's final wording corrections at `vnext/docs/superpowers/specs/2026-10-01-interceptor-contracts.md:28` and `vnext/docs/superpowers/research/2026-10-01-interceptor-contracts/README.md:28`. These documentation corrections are outside the packaged commit range; they do not change qualified source.
- Independently verified current HEAD as `4b8afdad92fccff28ccc29614e0a7ad5fdc21c2c` and all 1,555 manifest entries against current bytes, with zero mismatches. Manifest SHA-256: `516062b070ea4cd03ff324fa368f2b0a3e16fc5c364a3719c5a6e75e5d65f864`.
- Independently verified all 14 isolated protected paths and all 38 main-checkout protected paths against their preservation manifests, with zero mismatches. The 14-file collaboration overlay remains separate, uncommitted, and included in the tested candidate. The bare commit range is not the complete qualified artifact.

## Strengths

- The service boundary is small and domain-neutral. `RequestTransform<Req>` returns `undefined`, rejecting promise-returning and broad `void` callbacks; `beforeRequest` supplies only the original request, transforms synchronously, and returns `next()` directly (`vnext/packages/service/src/request-transform.ts:3`, `:8`). It adds no result wrapper, async success wrapper, runtime stage engine, registry scan, or global prepass.
- The gateway view retains the original Invocation through structural typing. Mutable payload replacement reaches the terminal, while the declared callback receives only payload and readonly flags (`vnext/packages/gateway/src/data-plane/chat-flow/shared/request-normalization.ts:5`, `:11`; `vnext/packages/protocols-llm/src/common/invocation.ts:10`). No temporary view object, deep copy, or restoration step is introduced.
- Error handling matches the requested contract: a transform throw delegates zero times; a synchronous downstream throw becomes a rejection after one delegation; existing rejected promises and error identity are retained (`vnext/packages/service/src/request-transform.ts:9`). Contract tests cover these cases and exact downstream promise/result identity (`vnext/packages/service/src/__tests__/request-transform.test.ts:30`, `:67`, `:117`, `:135`). The service tsconfig includes those type assertions.
- Reentry remains an around-interceptor responsibility. The unchanged runner closes over the same request and permits repeated downstream calls (`vnext/packages/service/src/index.ts:33`). Tests use actual registry arrays and replace the payload between turns, demonstrating that each new entry reads the latest payload (`vnext/packages/gateway/tests/data-plane/chat-flow/shared/request-normalization.test.ts:97`, `:134`, `:156`).

## Migration and architecture findings

All 21 leaf bodies were checked individually in the diff. Each keeps its exported name and protocol result annotation, constructs its adapter at module initialization, and removes only direct downstream control. Payload mutations/replacements, helper exports, flag gates, early exits, and field values are retained.

| Protocol | Individually checked migrations | Preserved details |
| --- | --- | --- |
| Responses, 7 | Empty-tools choice, forced-tool reasoning, role compatibility, prompt-cache removal, image declaration injection, DeepSeek normalization, Qwen normalization | String `none`, canonical reasoning sentinel, existing role order, flag gates, hosted-image duplicate/disabled checks, vendor-specific outbound fields |
| Messages, 5 | Empty-tools choice, forced-tool reasoning, role compatibility, billing attribution, eager-input-streaming removal | Object-form `none`, remaining output configuration, system role rewrite, original regex/block filtering, untouched nonobject tool entries |
| Chat Completions, 6 | Empty-tools choice, include-usage options, forced-tool reasoning, role compatibility, prompt-cache removal, Qwen normalization | Streaming-only usage override with other options retained, canonical sentinel, post-promotion role ordering, vendor field conversion |
| Gemini, 3 | Unsupported part fields, unsupported tools, safety settings | Existing exported synchronous helpers, in-place mutations, preservation of both `googleSearch` and `googleSearchRetrieval` |

The concrete integration risks were resolved as follows:

- **Chain position and provider placement:** the four registry arrays retain their existing order. Responses keeps prompt-cache stripping and image injection outside the hosted-tool loop, and empty-tools/roles/reasoning/vendor corrections inside its suffix (`responses/interceptors/index.ts:70`). Chat keeps its web-search loop outside the normalizers (`chat-completions/interceptors/index.ts:57`); Messages retains billing/eager cleanup before its loop and request corrections after it (`messages/interceptors/index.ts:49`). Gemini retains cleanup before thought filtering (`gemini/interceptors/index.ts:20`). Paths in this paragraph are relative to `vnext/packages/gateway/src/data-plane/chat-flow/`. Provider-declared Responses interceptors remain appended innermost (`responses/attempt.ts:367`).
- **Cross-protocol control flow:** Responses traversal remains inside its terminal (`responses/attempt.ts:375`); Messages and Chat cross-target branches return through traversal before creating their native source chains (`messages/attempt.ts:329`, `chat-completions/attempt.ts:125`); Gemini normalizes before traversal (`gemini/attempt.ts:182`, `:191`, `:225`). The corrected documentation now says explicitly that cross-target Messages/Chat requests bypass their native source registry. No universal phase interpretation is introduced.
- **Lazy tool reentry:** the Responses hosted-tool loop replaces `ctx.payload`, then calls its captured downstream continuation for later turns (`responses/interceptors/server-tool-shim.ts:1035`, `:1050`). Its event iterator and final-metadata resolution remain the existing owners (`:1084`, `:1216`). The adapter neither captures an old payload nor treats the initial lazy result return as stream completion.
- **Producer domain and native JSON:** request-only adapters never read a result. The existing source materializer validates producer identity and selects independent body/event translation (`responses/interceptor-source.ts:12`); stream-only mapping preserves the JSON adapter (`:35`). Translation still rejects nested producers, preserves disposal/final metadata, and retains opaque hub frames until the consumer chooses its adapter (`shared/traverse-translation.ts:143`, `:170`). The preserved collaboration overlay retains its separate body restoration path (`responses/interceptors/with-responses-collaboration-shim.ts:363`). No consumption, cancellation, cleanup, continuation, completion, or settlement authority is moved into normalization.
- **Quota/history and excluded owners:** the range changes no quota/history projection, attempt finalizer, provider retry, continuation store, producer contract, or tool/output owner. The callback cannot access those through its declared payload/flags interface. Chat DeepSeek/Kimi/reasoning dialect, whitespace guards, thinking/thought filters, compact/collaboration, hosted tools, and the no-op speed hint remain around-interceptors. Existing lifecycle regression suites are included in the recorded qualification below.
- **Documentation boundaries:** the README correctly treats the API as a trusted TypeScript contract, not runtime isolation or deep immutability, and reports no measured CPU/latency/heap benefit. Its Gemini count-tokens discrepancy is accurate: the unchanged handler directly translates at `gemini/count-tokens.ts:43`; it does not call the registry cleanup helpers. This is properly left as a follow-up instead of changing count-tokens behavior here. The reference audit supplies local pinned source pointers; this review does not claim a new exhaustive audit of the reference repository.

## Issues

### Critical (Must Fix)

None found.

### Important (Should Fix)

None found.

### Minor (Nice to Have)

1. **Inherited ESLint resolver advisory; non-blocking.** `vnext/eslint.config.mjs:18` selects multiple package/app tsconfigs, producing the advisory recorded at `.superpowers/sdd/2026-10-01-interceptor-contracts/task-2-lint.log:1` and `ci-local.log:8207`. I independently compared this configuration with the baseline and confirmed identical bytes. The message recommends resolver performance cleanup; it is not a source diagnostic, failed resolution, skipped typecheck, or failed lint run. It does not invalidate the contract or CI result. Address shared resolver configuration separately if useful; do not widen this refactor or add source suppressions to silence it.

### Resolved during review

- The draft research/spec wording could imply that a cross-target Messages/Chat request runs both target and native source registries. The controller clarified both line-28 descriptions to say the native source registry is bypassed; the final wording was reread and matches the source. No code fix was needed.

## Validation evidence and limits

- No tests or full CI were rerun by this reviewer: no uncovered behavior justified another run.
- Inspected the task logs: 457 passing tests, zero failures, 1,266 assertions across 48 files; service/gateway typechecks exit 0; purity OK. The affected run includes real registry reentry, four protocol attempts/interceptor directories, producer-domain/collaboration tests, hosted-tool behavior, Responses turn barriers, and dump exception ownership.
- The controller reported its single frozen-artifact CI process exited 0. The completed `.superpowers/sdd/2026-10-01-interceptor-contracts/ci-local.log` independently records purity OK (`:4`), package typechecks (`:9` onward), 5,631 pass / 1 skip / 0 fail (`:8201`), lint with 0 errors and 34 warnings (`:8301`), setup/dashboard builds, and Workers dry-run exit 0 (`:8326`). The lint warning paths are outside this range's changed source/test files. This is local qualification of source plus the preserved overlay, not pristine-commit or deployed-production evidence.
- **Cannot verify from this review:** future local fast-forward and post-integration byte equality; historical RED execution or all earlier process actions beyond the supplied reports; production behavior, clean installation, Docker deployment, live account compatibility, and resource/performance gains. The first item remains the controller's authorized integration step; the rest are not acceptance claims for this slice.
- No new schema, environment variable, flag, retry policy, lifecycle owner, `any`, suppression directive, or non-null assertion was introduced in the reviewed source range.

## Recommendations

- Complete the planned local integration and compare the resulting source with the frozen 1,555-file manifest while preserving both protected sets. Retain the overlay qualification boundary in the final report.
- Keep hosted-tool private-state lifetime/capacity, translation-trip ownership, typed settlement projection, workerd measurements, and release rollback/admission gates as separately scoped follow-ups.

## Assessment

**Ready to merge? Yes, for the authorized local integration of the reviewed source plus its preserved overlay.**

**Reasoning:** The contract narrows request-only authority without changing any of the 21 transformations, original ordering, Invocation identity, repeated-entry behavior, or result/lifecycle ownership. Focused coverage and the controller's completed frozen-artifact CI support integration; the inherited resolver advisory is non-blocking. This verdict does not authorize push/deployment or establish production readiness of the bare commit range.

Review operations were read-only source/Git inspection and hash comparison. No agent was spawned, and no source, index, HEAD, branch, dependency, service, or production state was modified by this reviewer. The only written artifact is this report.
