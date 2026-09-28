# C11 actual pinned-client gateway acceptance fixture

Date: 2026-09-29. Status: **prepared and honestly red** against vNext without the scoped 426 change. This is a scratch-only acceptance harness; no vNext product source, original Codex checkout, live CLI/config, paid upstream, or deployment was changed.

## Reusable fixture and command

Run `bash .superpowers/sdd/2026-09-29-reference-adoption-follow-up/codex-client-runtime/run-c11-gateway-acceptance.sh` from the `reference-adoption` worktree. It defaults to loading the Bun `bootstrapBunPlatform`, `getRepo`, and real `app.fetch` from `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify`. To test another worktree after its C11 implementation, set `C11_GATEWAY_SOURCE_ROOT=/absolute/path/to/worktree` before the same command. The runner prints the unique run directory and returns Cargo's test exit status; exit 101 is expected for the current red baseline and must not be treated as a passing test.

Files retained in `codex-client-runtime/`:

- `run-c11-gateway-acceptance.sh`: creates a unique scratch run directory, starts/stops both loopback services with a trap, launches Cargo with `--locked --offline`, 4 jobs and the retained isolated cache/target, then captures counts/logs/status. Bun and Rust subprocesses use `env -i`, scratch `HOME`/`CODEX_HOME`/XDG/TMPDIR, and no `CODEX_SANDBOX_NETWORK_DISABLED`. `RUST_MIN_STACK=16777216` is required on this host (see the earlier client fixture report).
- `gateway-fixture.ts`: calls the selected worktree's real Bun bootstrap and Hono app, seeds one dummy API key and one custom Responses upstream in a fresh SQLite file, and provides a local counted mock upstream. The mock emits `response.created` and a complete `response.completed` SSE envelope. The outer Bun transport records each actual gateway request **after** `app.fetch` returns, including method, path, `Upgrade` header, and status; it never replaces the gateway's route response. The mock records actual upstream POSTs separately.
- `codex-gateway-acceptance.patch`: only adds `suite::websocket_fallback::gateway_426_fallback_acceptance` and imports to the archived Codex `8ff74cc9` test harness. Existing first-party tests are unchanged. The test uses actual pinned client transport with `WireApi::Responses`, `supports_websockets=true`, the disposable key, and the gateway `/v1` base. It checks a successful Codex `TurnComplete` with no terminal error, then asserts one upgrade GET at 426, one HTTP POST at 200, and one upstream inference. The patched archive and previously built Cargo artifacts remain in scratch.

The exact executable environment and command lines are in the runner; no new Cargo dependency or lockfile change is needed. `bash -n run-c11-gateway-acceptance.sh` passes.

## Red baseline observed

Latest run: `codex-client-runtime/runs/c11.X8FkwH/`, using `reference-adoption-verify` HEAD `e7cc5383d8475d1baf14817ef8ca4aacaabdbc65`. Its `counts.json` is `{"get":2,"post":1,"upstream":1,"getStatuses":[404,404],"postStatuses":[200]}`. `logs/gateway-acceptance-requests.jsonl` independently records two real `GET /v1/responses` requests with `Upgrade: websocket`, both 404; then one real POST 200 and one local upstream POST. `logs/gateway-post-body.txt` captures gateway SSE with `response.created` and `response.completed` for the same response ID. The Codex terminal-error assertion passed; the test then failed at the expected `get == 1` assertion. Cargo reported `running 1 test`, `0 passed; 1 failed; 1726 filtered out`, exit 101. The test was not skipped.

Each run directory retains `gateway-acceptance.sqlite`, `gateway-acceptance-runtime.json`, `health.json`, `counts.json`, `test-exit-status.txt`, and server/client logs. The latest SQLite `PRAGMA quick_check` returned `ok`. The runner's trap stopped its dedicated Bun process; the latest gateway/upstream ports have no listener. `reference-adoption-verify` had concurrent unrelated uncommitted `server-tool-shim.ts` and hosted-identity test edits when inspected; this fixture did not modify them. Root should use the source-root override to point green acceptance at the worktree carrying the actual C11 fix.

This red run proves the pinned client reaches the real current gateway and exercises HTTP fallback after 404, but it does **not** complete C11: the desired immediate one-GET 426 fallback remains unimplemented at this tested source. It also does not test C12 WebSocket service support.

## Green result after scoped C11 implementation

Root ran the same pinned-client harness against the clean verification checkout carrying only the C11 candidate delta over `a3fce1ac`. Actual counts are [one upgrade GET 426, one POST 200, one upstream call](green-counts.json), also recorded in the [transport request log](green-requests.jsonl). The Codex test reports `1 passed; 0 failed; 1726 filtered out` and exits 0; it asserts a successful `TurnComplete` and no terminal error. The unrelated pinned client unused-import compiler warning remains.

Both dedicated loopback listeners were confirmed stopped after the runner exited, and the temporary SQLite database passed `PRAGMA quick_check`. This is actual pinned Codex-to-vNext Bun fallback acceptance with a synthetic counted upstream. Workers route behavior shares the handler and is typechecked/dry-run built, but a live Workers handshake and supported C12 WebSocket execution were not exercised.

The fixture sources and exact client patch are stored beside this document. Copy them into the retained isolated client runtime directory (beside `source`, `target`, `cargo-home`) to rerun; its default gateway path can be overridden by `C11_GATEWAY_SOURCE_ROOT`. All data and keys in these fixtures are synthetic.
