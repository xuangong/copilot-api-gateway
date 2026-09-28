#!/usr/bin/env bash
set -euo pipefail

D=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gateway_source=${C11_GATEWAY_SOURCE_ROOT:-/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify}
mkdir -p "$D/runs"
RUN_DIR=$(mktemp -d "$D/runs/c11.XXXXXX")
mkdir -p "$RUN_DIR/logs"
printf '%s\n' "$RUN_DIR" > "$D/latest-c11-run-dir.txt"
export RUN_DIR

gateway_pid=""
stop_gateway() {
  if [[ -n "$gateway_pid" ]]; then
    kill -TERM "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
}
trap stop_gateway EXIT INT TERM

cd "$D"
env -i \
  PATH=/Users/zhangxian/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  HOME="$D/home" TMPDIR="$D/tmp" C11_FIXTURE_RUN_DIR="$RUN_DIR" \
  C11_GATEWAY_SOURCE_ROOT="$gateway_source" \
  bun run "$D/gateway-fixture.ts" > "$RUN_DIR/logs/gateway-server.log" 2>&1 &
gateway_pid=$!

for ((attempt=0; attempt<100; attempt++)); do
  if [[ -s "$RUN_DIR/gateway-acceptance-runtime.json" ]]; then break; fi
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    cat "$RUN_DIR/logs/gateway-server.log"
    exit 1
  fi
  sleep 0.2
done
if [[ ! -s "$RUN_DIR/gateway-acceptance-runtime.json" ]]; then
  cat "$RUN_DIR/logs/gateway-server.log"
  exit 1
fi

gateway_base=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["gatewayBaseUrl"])' "$RUN_DIR/gateway-acceptance-runtime.json")
gateway_key=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["apiKey"])' "$RUN_DIR/gateway-acceptance-runtime.json")
curl --fail --silent --show-error --max-time 5 "$gateway_base/health" > "$RUN_DIR/health.json"

cd "$D/source/codex-rs"
test_status=0
env -i \
  PATH=/Users/zhangxian/.cargo/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  HOME="$D/home" RUSTUP_HOME=/Users/zhangxian/.rustup \
  CARGO_HOME="$D/cargo-home" CARGO_TARGET_DIR="$D/target" CARGO_BUILD_JOBS=4 \
  CODEX_HOME="$D/codex-home" XDG_CONFIG_HOME="$D/xdg-config" \
  XDG_CACHE_HOME="$D/xdg-cache" TMPDIR="$D/tmp" RUST_MIN_STACK=16777216 \
  C11_GATEWAY_BASE="$gateway_base" C11_GATEWAY_KEY="$gateway_key" \
  cargo test --locked --offline -p codex-core --test all \
    suite::websocket_fallback::gateway_426_fallback_acceptance -- --exact --nocapture \
  > "$RUN_DIR/logs/codex-client.log" 2>&1 || test_status=$?

curl --fail --silent --show-error --max-time 5 "$gateway_base/__fixture/counts" > "$RUN_DIR/counts.json"
printf '%s\n' "$test_status" > "$RUN_DIR/test-exit-status.txt"
printf 'run_dir=%s\nstatus=%s\n' "$RUN_DIR" "$test_status"
cat "$RUN_DIR/counts.json"
tail -n 20 "$RUN_DIR/logs/codex-client.log"
exit "$test_status"
