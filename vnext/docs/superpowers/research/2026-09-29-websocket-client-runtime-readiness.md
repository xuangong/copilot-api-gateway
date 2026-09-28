# C11/C12 pinned Codex client runtime readiness (read-only probe)

Date: 2026-09-29. Scope: existing first-party Codex loopback fixtures only. This probe made no source, gateway, live Codex configuration, daemon, credential, or deployment changes. It did not run a client acceptance test against vNext.

## Pinned source and executable fixture entry points

`/Volumes/Projects/codex` is at `8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f` (`git rev-parse HEAD`, observed). Its `codex-rs/core/tests/all.rs` contains `mod suite`, and `suite/mod.rs` includes both `websocket_fallback` and `client_websockets`. The package is `codex-core` (`core/Cargo.toml`). Thus the two targeted first-party test filters are:

```sh
cd /Volumes/Projects/codex/codex-rs
env -u CODEX_SANDBOX_NETWORK_DISABLED cargo test --locked --offline -p codex-core --test all suite::websocket_fallback::websocket_fallback_switches_to_http_on_upgrade_required_connect -- --exact --nocapture
env -u CODEX_SANDBOX_NETWORK_DISABLED cargo test --locked --offline -p codex-core --test all suite::client_websockets::responses_websocket_request_prewarm_reuses_connection -- --exact --nocapture
```

For a future run, set `CARGO_TARGET_DIR` to a dedicated disposable target directory and `CODEX_HOME` to a disposable directory before these commands. Keep network access limited to loopback. The tests call `skip_if_no_network!`, which **returns success without running assertions** when `CODEX_SANDBOX_NETWORK_DISABLED` exists (`core/tests/common/lib.rs:564-579`; constant in `core/src/spawn.rs:21`). Inspect output and test counts, not just exit code.

The 426 test uses a local Wiremock server: an upgrade `GET */responses` returns 426, a `POST` returns scripted SSE, and it asserts exactly one GET and one POST (`core/tests/suite/websocket_fallback.rs:34-82`). The warmup test uses the local `127.0.0.1:0` WebSocket fixture (`core/tests/common/responses.rs:1305-1340`), receives `response.created`/`response.completed` for `warm-1`, then asserts a second `response.create` on the **same connection** with `previous_response_id:"warm-1"` and `input:[]` (`core/tests/suite/client_websockets.rs:566-643`). Its provider uses an in-process mock endpoint and no environment auth key (`client_websockets.rs:2484-2510`); the harness creates a temporary Codex home (`:2573`). These tests prove pinned **client behavior against scripted servers** if run. They do not route through vNext, nor do the fixtures measure gateway provider calls or prove warmup zero inference. The tracked `vnext/docs/superpowers/research/2026-09-29-websocket-client-contract.md` already records the source-level contract.

## Local readiness result

- Rust toolchain is present: `cargo 1.95.0`, `rustc 1.95.0`, matching `codex-rs/rust-toolchain.toml`.
- There is no `codex-rs/target` or repository-root `target`, `CARGO_TARGET_DIR` is unset, and no matching prebuilt test binary was found under `/Volumes/Projects`. A first run would compile the large `codex-core` dependency graph.
- Executed `cargo metadata --offline --locked --format-version 1` in `codex-rs`, capturing output without writing a report to the checkout. It exited 101: `failed to download android_system_properties v0.1.5` / `attempting to make an HTTP request, but --offline was specified`. Therefore the targeted tests were **not attempted**; this is a concrete missing cached crate in addition to absent build artifacts, not a runtime failure of C11/C12. No install or network fetch was performed.
- A separate installed `/opt/homebrew/bin/codex` exists. With disposable `HOME`, `CODEX_HOME`, and `XDG_CONFIG_HOME`, and a stripped environment, only `codex --version` and `codex exec --help` were run; both exited 0. It reports `codex-cli 0.46.0` and accepts `-c/--config`, `-m/--model`, and `-C/--cd`. This executable is **not established as the pinned commit** and was not used to infer current WS behavior or to start a session.

## Smallest actual gateway acceptance path once prerequisites are ready

1. Populate the missing Cargo crate cache (or use an already built test artifact) and compile the two pinned filters into a dedicated temporary `CARGO_TARGET_DIR`. Run both loopback fixtures and confirm neither is skipped. This closes the first-party client-runtime evidence gap for the **scripted** 426 and warmup behaviors.
2. For **vNext compatibility**, run a fresh local gateway on an ephemeral port with temporary SQLite/key state and a local counted mock upstream, then point a pinned `8ff74cc9` Codex client or an adapted copy of its test harness at its `/v1` base URL with `wire_api="responses"` and `supports_websockets=true`. Capture actual upgrade, text frames, response IDs, and upstream call counts. Assert unsupported upgrade gives one GET then HTTP POST; when enabled, assert warmup `generate:false` emits created/completed with the same ID, makes zero upstream inference calls, and the generated turn uses `previous_response_id` plus `input:[]` on the same socket. Keep `CODEX_HOME`, provider config, account, gateway DB, and outputs temporary; do not point an existing user session or daemon at the gateway. The existing first-party fixtures are server-scripted and cannot by themselves assert these gateway outcomes.
3. The installed 0.46.0 CLI can be an **additional version-labeled** isolated smoke candidate using its `-c` provider overrides. It is not a substitute for the pinned-client fixture or a claim of compatibility with `8ff74cc9`.

This readiness gap does not block C12-F1/F2 implementation. It blocks only an **executed pinned-client compatibility claim** until the loopback and gateway-facing acceptance above actually run.
