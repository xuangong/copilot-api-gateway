# Responses WebSocket capability publication

C12 is complete for client-to-gateway single-turn Responses WebSocket ingress. Authenticated `GET /api/capabilities` reads the currently installed native adapter through request-scoped AsyncLocalStorage, with `Cache-Control: no-store`. Bun reports available with no connection-lifetime budget; Workers reports available with a 16,777,216-byte lifetime output budget. Direct Hono reports unavailable. All describe `single_turn`, with multiplex, fork and reconnect history false. Upstream transport remains HTTP/SSE.

The same request fact feeds both matched and synthesized Codex catalog `prefer_websockets`. Dashboard configuration enables `supports_websockets` only after a valid authenticated capability read. Unknown, loading, malformed, failed and aborted reads remain false; origin/session/key generation matching rejects stale true. Generated TOML escapes quotes, controls, Unicode and newlines. Capability reads skip upstream prewarming and do not change configuration or call upstream providers.

## Verification

Final exclusive `bun run ci:local` exited 0: **4,956 pass / 1 existing skip / 0 fail / 85,168 assertions**. Purity, all types, lint, UI build and Workers dry-run passed. Lint retains 35 inherited warnings and the multi-project advisory. Independent initial review found fake-database and unexecuted fetch-error test coverage; fix1 uses real migrated temporary SQLite and distinct active-fetch/pre-abort tests, and narrows the platform export to the wrapper. Scoped re-review approved with no remaining Critical or Important findings.

Root ran the frozen candidate through real Bun/SQLite, Chromium and workerd/D1. The retained browser probe covers native/direct/failed-read snippets, real 101/426, matched/unmatched catalog, auth/no-store, no capability egress, and an in-handler held native read concurrent with bare Hono in the same process. Its origin-switch late-response test navigates between documents; same-document session/key invalidation is separately covered by focused state/gate tests, not claimed as a browser session-switch measurement. The complete fixture records one blocked external catalog attempt; capability reads themselves record zero upstream calls.

The workerd probe confirms the same-isolate native true/16-MiB versus bare false/null, four concurrent reads, auth/no-store, unchanged configuration revision, zero capability upstream calls and matched/unmatched catalog behavior. The checked-in native workerd suite additionally exercises all four real 101 routes. Existing F3/F4 actual pinned Codex client and transport-pressure evidence remains in its prior packages; this capability package does not claim to rerun that unchanged client suite.

All 22 frozen product hashes were unchanged after final acceptance. Screenshots contain only synthetic identities/keys and confirm the visible Codex snippet. Root viewed the native screenshot. No migration or environment variable was added. No push, deployment, native upstream WebSocket, automatic reconnect, universal client compatibility, peer acknowledgement or production validation is claimed.

## Reproduce

Build the dashboard in the chosen checkout. For Bun/browser, run `run.sh` with `C12_CAPABILITY_SOURCE_ROOT=<checkout>/vnext`, `C12_CAPABILITY_PATH=/api/capabilities`, `C12_CAPABILITY_BOOLEAN_POINTER=/codex/responsesWebSocket/available`, and `C12_STRUCTURED_ASSERTIONS_FILE=<this directory>/contract-assertions.json`. The script uses the recorded local Node/Playwright installation and writes isolated run data under the temporary directory; `C12_CAPABILITY_RUNS_ROOT` can override that location. It stops only its own fixture. The final wrapper output location was moved outside the product tree and syntax-checked after runtime acceptance; probe behavior is unchanged.

Run `VNEXT_PROBE_ROOT=<checkout> bun workerd-validate.mjs` for workerd/D1. It reuses the retained F4 independent Node producer, creates only temporary D1 state, and blocks nonfixture egress. This probe uses the guarded Miniflare outbound bridge and makes no cancellation inference; F4 direct-fetch cancellation evidence is separate.
