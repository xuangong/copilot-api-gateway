# D02 execution adapter independent review

## Spec compliance

- **PASS for this adapter / terminal-provider package.** No missing, extra, or misunderstood requirement established in the 24-file frozen patch against `1a06f90020dac71142b10cf03100fa827016c2dc`. This does not approve complete D02 activation. The exact candidate inspected was `.worktrees/reference-adoption-verify`.
- **Quality: Approved.** No Critical or Important finding in the scoped implementation. The inherited validation warning count and accepted hostile-object boundary are recorded below.
- The adapter selects fixed operation labels from endpoint/action, keeps one request-local parent sequence, uses its trusted configured upstream ID, and omits raw URLs (`vnext/packages/gateway/src/shared/dump/upstream-dial-adapter.ts:14`, `:31`, `:38`, `:42`). The collector retains the required caps of 8 attempts, 64/256 KiB prefixes, 1 MiB total body, 16 KiB headers per attempt, and 64 KiB metadata (`vnext/packages/gateway/src/shared/dump/upstream-attempts.ts:4`).
- Native text capture counts UTF-8 without full-body encoding, treats malformed UTF-16 as replacement characters, and permits an exact prefix ending inside a code point; byte capture borrows only synchronously before the collector copies into bounded pages (`vnext/packages/gateway/src/shared/dump/upstream-dial-adapter.ts:96`, `:109`; `vnext/packages/gateway/src/shared/dump/upstream-attempts.ts:105`, `:254`). Opaque bodies remain unobserved.
- Lazy response observation, original-response fallback on wrapper failure, status-zero bypass, and explicit-clone metadata preservation are implemented at `vnext/packages/gateway/src/shared/dump/upstream-dial-adapter.ts:53`, `:140`. Source reads and cancellation remain in the existing pull-through collector (`vnext/packages/gateway/src/shared/dump/upstream-attempts.ts:270`, `:304`), with no adapter-side source clone, tee, or pre-read.
- All six provider/plugin seams are present. The changed terminal send sites are `vnext/packages/provider-copilot/src/provider.ts:203`, `vnext/packages/provider-custom/src/provider.ts:179`, `vnext/packages/provider-azure/src/provider.ts:160`, `vnext/packages/provider-codex/src/fetch.ts:511`, `vnext/packages/provider-claude-code/src/fetch.ts:171`, and `vnext/packages/provider-sdf/src/provider.ts:231`. Codex/Claude explicitly retain ordinary fetchers for internal OAuth; their optional execution fetchers affect only application dispatch. The optional resolver preserves ordinary defaults and isolates factory construction failures (`vnext/packages/provider-llm/src/plugin.ts:17`).

## Strengths

- The narrow two-fetcher seam avoids changing retry ownership or provider request preparation. Codex continues to use its prepared body and identity at dispatch (`vnext/packages/provider-codex/src/fetch.ts:493`, `:505`); Claude's refresh recurses with the same options while OAuth still receives `opts.fetcher` (`vnext/packages/provider-claude-code/src/fetch.ts:128`, `:197`).
- Regression tests exercise real provider code with injected transport functions: Copilot variant discovery plus 401/session refresh, Custom/Azure discovery, Codex/Claude OAuth retries, and SDF passport separation (`vnext/packages/provider-copilot/src/__tests__/injected-fetcher.test.ts:74`, `:108`; `vnext/packages/provider-custom/src/__tests__/injected-fetcher.test.ts:127`; `vnext/packages/provider-azure/src/__tests__/injected-fetcher.test.ts:108`; `vnext/packages/provider-codex/src/__tests__/provider.integration.test.ts:249`; `vnext/packages/provider-claude-code/src/__tests__/provider.integration.test.ts:241`; `vnext/packages/provider-sdf/__tests__/headers.test.ts:81`).
- The new adapter tests assert observable byte ownership, Unicode byte counts, original response usability after metadata failure, metadata/clone behavior, and cancellation rather than merely callback counts (`vnext/packages/gateway/tests/upstream-dial-adapter.test.ts:55`, `:75`, `:95`, `:129`, `:159`, `:199`).

## Issues

### Critical

- None established in the scoped patch.

### Important

- None established in the scoped patch.

### Minor / known validation noise

- `task-D02-execution-adapter-report.md:24` reports 36 lint warnings, so the reported lint run is not warning-free. `progress.md:357` already records the same 36 inherited warnings at the accepted prerequisite. No newly introduced warning is established by this review; root should retain that baseline distinction in final CI evidence rather than call the output pristine. No suite was rerun to regenerate the warning list.

## Named dependency checks and accepted boundary

- **Risk: lazy headers might enumerate caller-controlled metadata.** Checked only `vnext/packages/dial/src/fetcher.ts:385-441`: materialized attempts pass the transport's prepared header record; direct fetch supplies only a `Headers` data slot. The adapter consumes these lazily and the collector persists only its normalized allowlist (`vnext/packages/gateway/src/shared/dump/upstream-dial-adapter.ts:84`; `vnext/packages/gateway/src/shared/dump/upstream-attempts.ts:204`).
- **Known limit:** `vnext/packages/dial/src/fetcher.ts:413-425` still uses JavaScript reflection, so arbitrary Proxy traps can mutate their own request input. The independent prerequisite review already reproduced this (`task-D02-dial-observer-review.md:20-26`) and root explicitly accepted trusted/plain gateway DI and provider-created inputs (`progress.md:355`). I agree this is not a newly introduced or HTTP-client-reachable defect demonstrated by this package. It must not be described as absolute side-effect-free introspection of arbitrary executable JavaScript objects. The separate optional observer-getter P3 remains owned by final broad review.
- **Risk: wrapper or collector failure could consume the original response or turn cancellation into EOF.** The patch's collector hunks were cut mid-function, so I read the existing `observeResponse`/terminal handling at `vnext/packages/gateway/src/shared/dump/upstream-attempts.ts:261-365`, plus bounded-copy code at `:99-133`. The adapter itself never acquires a source reader; its exception fallback therefore leaves the source usable. Existing pending-read cancellation and diagnostic-copy test names were checked; their reported suite was not rerun.
- **Risk: a new fetch-options member might route OAuth through execution capture or disturb retry preparation.** The Codex/Claude diff hunks were cut mid-function, so I read the relevant dispatch/auth/retry functions and searched their `opts.fetcher` call sites. OAuth remains ordinary; application retries reuse the execution fetcher. This was a focused contract check, not a broader provider audit.

## Cross-task checks still required for complete D02

- **Not implemented in this package:** retention-gated collector allocation, explicit dump propagation through registry/bindings/routes, owner isolation, the request-token Copilot fallback, alpha-search retention, every endpoint family through real dispatch, and sidecar/detail/export composition. These remain the route activation package's acceptance matrix (`task-D02-execution-adapter-report.md:13`). No route/storage/auth/usage acceptance is inferred from provider fake-fetcher tests.
- **Root-owned runtime acceptance:** I inspected `/tmp/vnext-d02-adapter-final-runtime.out`: both Bun and local workerd report `passed: true`, preserve redirect/status metadata and three equal clone byte arrays, record 95,542 UTF-8 bytes with a 65,536-byte prefix, keep unique parent IDs, and pass cancellation/finish-then-cancel cases. Root identified this as the exact frozen candidate run and supplied `task-D02-adapter-runtime.mjs` / `task-D02-adapter-worker.ts` as its scripts; I did not rerun it. Root also reported final `ci:local` exit 0 with **4,328 pass / 1 skip / 0 fail**, 36 inherited lint warnings, and successful typecheck/purity/build/Workers dry-run. The CI result is controller-reported rather than independently rerun or log-audited. This does not establish production deployment or actual activated-request coverage.

## Validation performed by this review

- Read the adapter brief, wiring brief/boundary map, implementation report, governing AGENTS instructions, and all 24 files in the frozen patch once. Per-file provider/plugin/test coverage was checked against the brief.
- Performed only the focused dependency/context reads listed above and inspected the root runtime result JSON. No tests, typechecks, build, lint, Git commands, network requests, service operations, or product mutations were performed. The only written artifact is this review report.
- Implementer-reported evidence remains **89 pass / 0 fail / 381 assertions**, workspace typecheck exit 0, purity OK, lint 0 errors / 36 inherited warnings, and diff check exit 0 (`task-D02-execution-adapter-report.md:17-25`). These are reported results, not an independent rerun.

## Assessment

**Task quality: Approved.** The implementation keeps diagnostics request-local and optional, places observation at the terminal application fetch boundary, and preserves ordinary discovery/auth transport. Complete D02 and merge readiness still depend on the explicitly separate route activation and root verification gates.
