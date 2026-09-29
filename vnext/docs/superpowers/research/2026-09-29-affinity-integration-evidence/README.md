# Responses and Messages opaque-affinity production integration

Base: `b09541c5988ab1c916b753d70c850964637ebaf3`. This evidence covers authenticated source routing, actual execution fences, source-domain egress and durable continuation for Responses and Messages. It does not claim deployment, full Claude account affinity, Chat/Gemini client adapters or operator-configured compatibility widening.

## Frozen actual-runtime acceptance

All fixtures use synthetic credentials/data, temporary SQLite/D1/R2, loopback HTTP or a Miniflare outbound service restricted to the synthetic host. No live account, production database or upstream was used. Product/test hashes were checked unchanged across these runs.

| Fixture | Verified behavior | Result |
| --- | --- | --- |
| `task-C01-integration-app-runtime.mjs` | Actual authenticated Bun app and CustomProvider; native and both cross-protocol JSON/SSE; exact raw replay; full thinking whitespace; wrong key/owner/domain/companion; required pin/mixed conflicts; optional whole-block removal; foreign pass-through; nested agent state and slot-substitution rejection; item-done/terminal carrier equality; immediate durable continuation; key mapping/pin/disabled policy; official SDK aggregation/replay | 27 case groups passed, 29 synthetic upstream calls |
| `task-C01-integration-providers-runtime.mjs` | Actual Copilot Fast/context/effort resolution and Azure deployment; real SQLite configuration authority; preparation without session/network work; configuration replacement before dispatch; 401 replacement before refresh/retry; aborted preparation | 6 groups passed, 5 inference calls, 0 refreshes |
| `task-C01-integration-d1-runtime.mjs` | Actual app/workerd/WebCrypto/D1 response store; authenticated egress; wrong-key/pin rejection without new outbound calls; immediate durable continuation; configuration replacement; private key-secret initialization | 5 groups passed, 2 synthetic outbound calls |
| Existing execution prerequisite `../2026-09-29-affinity-execution-evidence/task-C01-execution-runtime.mjs` | Actual Codex normal/Lite raw identity; config/revision/incarnation changes; expiry before OAuth; 401 replacement; account replacement during pending OAuth without recursive mint | 9 groups passed, 4 network calls including 1 allowed old-account OAuth call |

Additional frozen fix2 fixtures passed:

| Fixture | Verified behavior | Result |
| --- | --- | --- |
| `task-C01-integration-companion-runtime.mjs` | Partial delta/final summary suffix, raw replay, conflict error without signed success | 3 groups, 3 calls |
| `task-C01-integration-bounds-runtime.mjs` | Paced native signature overflow before completion, real Bun upstream cancel, source SSE and JSON, error rather than cancelled metrics, no success snapshot | Both requests stop before 40 chunks |
| `task-C01-integration-bounds-node-runtime.mjs` | Same gateway behavior with independent Node HTTP upstream socket-close evidence | Bun gateway 1.3.0 / Node upstream 26.0.0; 10 and 9 of 40 chunks |
| `task-C01-integration-lazy-runtime.mjs` | Plain output does not initialize secret, changed key owner fails before signing, in-flight old-config required replay cannot authorize replacement | 3 groups, 3 calls |
| `task-C01-integration-tool-fields-runtime.mjs` | Ordinary large tool business fields are preserved in native JSON/SSE and SSE-to-JSON, without secret initialization | 3 groups, 3 calls |
| `task-C01-integration-sse-json-runtime.mjs` | All four Responses/Messages source JSON and explicit upstream SSE pairs preserve complete thinking/signature and exact raw replay | 4 groups, 8 calls |

Machine-readable outcomes are in adjacent `*-result.json` files. Temporary filesystem paths identify isolated fixtures, not production resources.

The app fixture uses installed official OpenAI **6.33.0** and Anthropic **0.80.0** SDKs, with `.responses.stream().finalResponse()` and `.messages.stream().finalMessage()` followed by replay. The SDK imports point to the retained isolated `/tmp/vnext-reference-sdk-probe` installation. Pinned native Codex carrier aggregation/replay was already verified in the execution-prerequisite evidence; it was not needlessly recompiled for this package.

Run from `vnext/`, setting `VNEXT_PROBE_ROOT` to the repository checkout:

```sh
VNEXT_PROBE_ROOT=/absolute/checkout bun docs/superpowers/research/2026-09-29-affinity-integration-evidence/task-C01-integration-app-runtime.mjs
VNEXT_PROBE_ROOT=/absolute/checkout bun docs/superpowers/research/2026-09-29-affinity-integration-evidence/task-C01-integration-providers-runtime.mjs
VNEXT_PROBE_ROOT=/absolute/checkout bun docs/superpowers/research/2026-09-29-affinity-integration-evidence/task-C01-integration-d1-runtime.mjs
```

The D1 fixture uses the repository's exact installed Miniflare/Wrangler versions and its adjacent Worker template. It exercises the real local Workers runtime; this is not a Cloudflare production deployment.

## Canonical output boundary

The generic Responses final-output assembler retains its existing terminal-wins rule for ordinary items. Once an activated request has emitted an authenticated opaque item in `output_item.done`, its full bound companion and carrier are fixed for terminal output and durable storage. A request-local cache reconciles ID and canonical closed-position lookup, including sparse/no-ID and duplicate-ID cases. Terminal-only opaque items are signed on finalization. Messages signature fragments are buffered within the carrier limits and emitted once before block stop. Source translation happens before signing.

## Verification record and limits

The final implementer fix2 run passed 1,232 tests with zero failures and 3,263 assertions across 131 files, plus six package typechecks. A final 22-case actual HTTP/SQLite suite additionally checked complete initial/delta tool and thinking input, raw replay, secret laziness and error metrics. The report is included as `task-C01-integration-report.md`. Independent initial/fix1 reviews are retained. The final scoped fix2 review approves both specification compliance and quality, with both remaining Important findings addressed. All ten root frozen runtime processes passed; final full CI passes **4,805 tests, 1 existing skip, 0 failures and 84,496 assertions**, plus all package typechecks, framework purity, lint (35 inherited warnings), dashboard build and Workers deployment dry-run. Product hashes remained unchanged.

Initial review found unbounded hidden signature buffering, incomplete final companion, and nested-slot substitution; fix1 corrected the data issues and restored unchanged zero-SQL warm dispatch (from N+7 extra SELECTs). Its full CI passed 4,784 tests, one existing skip, all gates, but independent review and actual runtime still found incomplete HTTP cancellation and a tool-business-field false positive. Fix2 uses a child upstream AbortController and explicit native field positions. It also handles explicit upstream SSE for JSON clients and preserves their initial/delta data. `task-C01-bun-cancel-control.mjs` and `task-C01-node-upstream-cancel-control.mjs` independently explain the runtime need: on Bun 1.3.0, body reader cancellation alone does not close the upstream socket within the bounded observation window; an explicit request abort does. These controls use no gateway or live service.

A root diagnostic initially updated model mappings with direct SQL, bypassing the existing process-local configuration invalidator, and received the cached old policy (404). The fixture now uses the production `patchModelMappings` repository entry point; same-target mapped replay passes. This was a fixture correction, not a product fix or a claim that direct SQL changes become immediately visible.

Owner compatibility declarations remain a separate follow-up. Unknown Claude execution targets safely reject required owned state or project optional complete blocks; they do not gain claimed account compatibility. Required opaque state cannot use a lossy translator. Chat/Gemini client adaptation remains queued. This package adds no new migration, environment variable, retention surface or plaintext dump; it relies on the previously accepted affinity-secret migration. No push or deployment was performed.
