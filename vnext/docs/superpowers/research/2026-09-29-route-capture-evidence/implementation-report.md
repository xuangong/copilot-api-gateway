# D02 route activation implementation report

Date: 2026-09-29. Accepted base: `a68a6732dddfdf78a1bad06c634ad9fd3cb8286b`.
Writer: `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify` only.
Status: **product frozen for root review and final clean CI / independent runtime acceptance**. No commit, merge, push, deployment, or live configuration/data operation performed. The dirty implementation/main worktrees were not edited. Root owns protected-file preservation and integration.

## Product behavior and API seams

- `DumpAccumulator.upstreamDialObservation()` lazily allocates/reuses one collector and one parent-call counter for that retained request. Existing `openRequestDump` / `openDumpAccumulator` retention is the gate. Retention-off never calls this method. Existing finalization snapshots the collector; existing storage/detail wire persists/exposes the safe envelope.
- Optional `dump` travels explicitly through registry, candidates, binding resolution, all four chat serve/attempt pairs, translation/hub attempts, both count-token routes, embeddings, JSON images and multipart edits. `RunAttemptArgs.dump` forwards the existing opaque kit sink without a gateway type dependency.
- Ordinary and observed factories share the loaded proxy catalog, fallback map, runtime and transports. `createPerRequestFetcher` accepts an optional observer on its returned factory. Terminal execution selects the fixed operation via `operationForProviderRequest` and the accepted provider execution seam. Discovery/session/OAuth/passport/probe fetchers stay ordinary.
- Request-token Copilot uses `createObservedDirectFetcher` with fixed logical ID `copilot_request`. It retains direct runtime fetch and never looks up a synthetic stored upstream row. Its `/models` remains ordinary.
- Alpha search now opens/finalizes its logical dump through the existing retention opener. Passthrough forwards that dump to selection. Local search-engine HTTP is excluded and does not create an application sidecar.
- `GatewayRequestContext` is a gateway-local extension carrying dump into `ServerToolRequestCtx` and image `ShimState`. Shared protocol and authentication `BindingScope` are unchanged. Image re-enumeration and subsequent Responses turns share collector/call IDs.
- The existing image server-tool source contains a NUL byte. Default `rg` treated it as binary and hid its binding re-enumeration in the earlier boundary map. `rg -a` found the site. This package wires it and preserves the original NUL; root explicitly approved this existing re-entrant scope.

## Verified matrix

The new `vnext/packages/gateway/tests/dump-route-activation.test.ts` contains **36 tests**, using the real app/auth, temporary-file Bun SQLite, `BunSqliteRepo`, `FileDumpStore`, and filesystem sidecars. Only external HTTP and the proxy-failure socket boundary are controlled. No `mock.module`, SQLite mock, or fake repo/database.

| Area | Evidence |
| --- | --- |
| Endpoints | Chat Completions, Messages, Responses, compact, Gemini generate/streamGenerate, Anthropic/Gemini count_tokens, embeddings, image generations, multipart edits, both alpha-search paths capture only their terminal operation. |
| Translation | Chat -> Responses, Messages -> Chat, Responses -> Messages, Gemini -> Responses retain capture. |
| Re-entrant / secondary binding | Actual hosted image tool produces Responses `call_1`, image on another upstream `call_2`, second Responses `call_3`; all EOF in one dump. |
| Copilot refresh/retry | Both 401 and 403 cause actual gateway session refresh, then a 429 cancelled with zero source reads, then success. Three application parents persist; both exchanges/models are excluded. Synthetic clock advancement elapses the existing refresh cooldown without altering production logic. |
| Fallback | Actual registry/dial/proxy machinery attempts a SOCKS proxy with controlled connection failure, then direct fetch: two children, one parent, real SQLite proxy backoff. |
| Request-token | Real registry synthetic binding, direct application transport, safe `copilot_request`, models excluded, no stored row. |
| Owners / off | Two concurrent owners have separate upstreams/parent sequences; own detail 200, foreign 403, exports redacted. Off opens no observation context, dump or spilled file, and preserves original provider body identity. |
| Streams | Real route parser handles complete/malformed finite SSE; both transport totals are exact EOF while malformed SSE independently marks logical failure. Binding no-read = `not_consumed`; cancel = `cancelled`; source failure = `read_error`. Actual caller abort cancels source with observed prefix and unknown final total. |
| Prefix caps | 70 KiB input / 300 KiB output preserves full client JSON while request/response prefixes stop at 64/256 KiB; observed totals remain exact and truncation explicit. Accepted collector tests cover total budgets, attempt caps, backing buffers and metadata. |
| Redaction | URL userinfo/host/path/query/fragment credentials, custom account header, response credential header absent from decompressed sidecar/detail/export. Filesystem sidecar equals safe stored envelope. |
| Exclusions / failures | Ordinary models, explicit provider probe and retained discovery emit no child. Actual local LangSearch HTTP creates no application sidecar. Throwing observation setup preserves successful inference. Accepted six-provider suites cover discovery/OAuth/session/passport split; accepted storage suites cover sidecar failures. |

## Commands and results

All ran from the writer's `vnext/` directory.

```sh
bun test packages/gateway/tests/dump-route-activation.test.ts packages/gateway/tests/upstream-dial-adapter.test.ts packages/gateway/tests/upstream-attempts.test.ts packages/gateway/tests/dump-upstream-sidecar.test.ts packages/gateway/tests/data-plane-per-request-dial.test.ts packages/gateway/tests/providers-registry-proxy.test.ts packages/gateway/tests/providers-registry.test.ts packages/gateway/tests/control-plane-dump-auth-sqlite.test.ts packages/dial/src/__tests__/fetcher.test.ts packages/provider-copilot/src/__tests__/injected-fetcher.test.ts packages/provider-custom/src/__tests__/injected-fetcher.test.ts packages/provider-azure/src/__tests__/injected-fetcher.test.ts packages/provider-sdf/__tests__/headers.test.ts packages/provider-codex/src/__tests__/provider.integration.test.ts packages/provider-claude-code/src/__tests__/provider.integration.test.ts
```

Final focused run: **215 pass, 0 fail, 919 assertions, 15 files**, exit 0. Log `/tmp/d02-focused-tests.out`.

- `bun run typecheck`: all workspace packages exit 0 (`/tmp/d02-typecheck.out`).
- `bun run lint`: exit 0; 0 errors, 36 existing warnings (`/tmp/d02-lint.out`).
- `bun run scripts/check-framework-purity.ts`: OK (`/tmp/d02-purity.out`).
- After final context-order/test additions, `bun run --filter '@vibe-llm/gateway' typecheck`: exit 0 (`/tmp/d02-final-gateway-typecheck.out`).
- `bunx eslint packages/gateway/tests/dump-route-activation.test.ts packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`: exit 0, no lint findings (`/tmp/d02-final-lint.out`; configuration advisory only).
- `git diff --check`: exit 0.

Early failures were fixture assumptions and were corrected before final verification: concurrent background-drain race; finite malformed SSE reaching transport EOF before protocol failure; Bun 1.3 lacking global DecompressionStream (sidecar inspection uses node:zlib); canonical dump frames remaining stream storage even for JSON clients (cap test checks actual client JSON).

## Limits and freeze handoff

- Root owns final `bun run ci:local`, independent workerd/D1/R2/loopback acceptance, and protected Responses integration. This report does not claim those final gates complete. Root reported preliminary runtime acceptance passing; that separate pre-freeze evidence does not substitute for its frozen rerun.
- New routes exercise Custom, stored Copilot and request-token Copilot. Other providers' terminal/discovery/auth split is exercised by the accepted package integration suites, not a new full provider-by-route Cartesian product or live vendor test.
- No live credentials/infrastructure were used. Proxy failure controls the socket boundary; root's fixture exercises actual local HTTP.
- The representation is HTTP adapter `fetch-body`, potentially runtime-decompressed. Prepared bytes do not prove socket writes. Direct multipart remains request `unobserved`.
- Sidecars contain actual transport children. Pre-dispatch failure fabricates none; zero children does not prove zero provider/logical calls. Transport EOF can coexist with protocol failure. Cancel/error/no-read leaves total unknown.
- `task-D02-route-activation-owned.json` lists exactly **27 product paths**; root documentation is excluded. Product is frozen and this writer will make no further changes unless root requests follow-up.
