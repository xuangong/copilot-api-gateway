# C11/C12 pinned Codex client fixture build and run

Date: 2026-09-29. This task ran first-party Codex client tests against their **scripted local servers**. It did not run a client against vNext or change gateway source, the live Codex checkout, credentials, a daemon, or deployment state.

## Source and isolation

- Source: `/Volumes/Projects/codex` commit `8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f`, verified with `git -C /Volumes/Projects/codex rev-parse ...^{commit}`. The source was copied by `git archive --format=tar <commit> | tar -xf - -C <scratch>/source`; archived tree ID `ea853698a6b9cc0e1ecf2186124c8dfbc5b86d1f` matches `git rev-parse <commit>^{tree}`. The original checkout remained clean.
- Scratch root: `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption/.superpowers/sdd/2026-09-29-reference-adoption-follow-up/codex-client-runtime`. Source, public Cargo cache, compiled target, logs, and disposable runtime directories remain there for gateway-facing acceptance work. Current sizes: source 86 MB, Cargo home 1.1 GB, target 8.9 GB.
- Toolchain: `rustc 1.95.0`, `cargo 1.95.0`; `RUSTUP_HOME` points only to the existing installed toolchain. `CARGO_BUILD_JOBS=4`. The test processes used `env -i` with only the explicit variables below, so normal user credentials and config were not inherited. `HOME`, `CODEX_HOME`, XDG directories, `TMPDIR`, `CARGO_HOME`, and `CARGO_TARGET_DIR` all point inside scratch. `CODEX_SANDBOX_NETWORK_DISABLED` was absent. Cargo fetched public crates/Git dependencies; tests used their loopback fixtures.

## Exact reproducible commands

The source setup used:

```sh
D=/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption/.superpowers/sdd/2026-09-29-reference-adoption-follow-up/codex-client-runtime
mkdir -p "$D"/{source,logs,cargo-home,target,home,codex-home,xdg-config,xdg-cache,tmp}
git -C /Volumes/Projects/codex archive --format=tar 8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f | tar -xf - -C "$D/source"
git -C /Volumes/Projects/codex rev-parse 8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f^{tree} > "$D/source-tree.txt"
cd "$D/source/codex-rs"
```

The three test invocations used the same explicit environment. The first had no `RUST_MIN_STACK`; the two successful reruns set `RUST_MIN_STACK=16777216` (16 MiB). The following function spells out the environment and exact test filters, with `D` set above; invoke each line sequentially from `source/codex-rs`:

```sh
fixture() {
  env -i \
    PATH=/Users/zhangxian/.cargo/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
    HOME="$D/home" RUSTUP_HOME=/Users/zhangxian/.rustup \
    CARGO_HOME="$D/cargo-home" CARGO_TARGET_DIR="$D/target" CARGO_BUILD_JOBS=4 \
    CODEX_HOME="$D/codex-home" XDG_CONFIG_HOME="$D/xdg-config" \
    XDG_CACHE_HOME="$D/xdg-cache" TMPDIR="$D/tmp" "$@"
}
fixture cargo test --locked -p codex-core --test all suite::websocket_fallback::websocket_fallback_switches_to_http_on_upgrade_required_connect -- --exact --nocapture > "$D/logs/426-fallback.log" 2>&1
fixture RUST_MIN_STACK=16777216 cargo test --locked -p codex-core --test all suite::websocket_fallback::websocket_fallback_switches_to_http_on_upgrade_required_connect -- --exact --nocapture > "$D/logs/426-fallback-stack16m.log" 2>&1
fixture RUST_MIN_STACK=16777216 cargo test --locked -p codex-core --test all suite::client_websockets::responses_websocket_request_prewarm_reuses_connection -- --exact --nocapture > "$D/logs/prewarm-reuse-stack16m.log" 2>&1
```

`fixture` above reproduces the effective `env -i` environment of the executed full-path commands; actual commands used the same resolved values directly. An initial shell redirection typo (`../logs` instead of `../../logs` from `source/codex-rs`) failed before Cargo started and had no test outcome.

## Observed results

| Invocation | Exit | Actual test result |
| --- | ---: | --- |
| 426 fallback, default test-thread stack | 101 | After `Finished test profile ... in 8m 16s`, `running 1 test`, then `has overflowed its stack` and `SIGABRT`; no pass result. |
| 426 fallback, `RUST_MIN_STACK=16777216` | 0 | `running 1 test`; `1 passed; 0 failed; 0 ignored; 0 measured; 1725 filtered out` in 0.44 s. |
| Prewarm reuse, `RUST_MIN_STACK=16777216` | 0 | `running 1 test`; `1 passed; 0 failed; 0 ignored; 0 measured; 1725 filtered out` in 0.15 s. |

The prewarm log records `connection=0 received request=0` and `connection=0 received request=1`, both `response.create`, with `response.created`/`response.completed` batches. The test environment omitted `CODEX_SANDBOX_NETWORK_DISABLED`, so `skip_if_no_network!` did not take its skip branch; `running 1 test` and the pass counts confirm the exact filters. The default-stack failure is preserved separately; a larger test-thread stack was required on this host. The only compiler warning was an unrelated unused `body_json` import in `core/tests/suite/openai_file_mcp.rs`.

Logs: `codex-client-runtime/logs/426-fallback.log`, `426-fallback-stack16m.log`, and `prewarm-reuse-stack16m.log`. SHA-256, respectively: `15b538cb95fe8673c159ba80b422db70615a4fe8f952731e5b5e37020f879d23`, `10470047a05a563f8e6126590ca47ad977e071e1c401a93f742bcbafe3e6b94f`, and `3a906243f07ea87af15887ba9dc110a7d3b35b77b57d55b4310ae7701e331e2e`.

These results establish pinned client behavior against local scripted fixtures only. They do **not** establish vNext WebSocket compatibility, gateway warmup zero upstream inference, or gateway fallback handling. Root-owned gateway loopback acceptance must test those separately using the retained pinned source and artifacts.
