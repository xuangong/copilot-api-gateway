#!/bin/zsh
set -euo pipefail

# Run after the capability route/JSON contract and dashboard bundle
# are frozen. Every invocation creates a fresh SQLite database and loopback ports.
here=${0:A:h}
source_root=${C12_CAPABILITY_SOURCE_ROOT:-${here}/../../../..}
capability_path=${C12_CAPABILITY_PATH:-}
boolean_pointer=${C12_CAPABILITY_BOOLEAN_POINTER:-}
assertions_file=${C12_STRUCTURED_ASSERTIONS_FILE:-}

if [[ -z "$capability_path" || -z "$boolean_pointer" ]]; then
  print -u2 "C12_CAPABILITY_PATH and C12_CAPABILITY_BOOLEAN_POINTER are required after the product contract freezes"
  exit 2
fi
if [[ -n "$assertions_file" && ! -f "$assertions_file" ]]; then
  print -u2 "C12_STRUCTURED_ASSERTIONS_FILE does not exist: $assertions_file"
  exit 2
fi
source_root=${source_root:A}
if [[ -n "$assertions_file" ]]; then assertions_file=${assertions_file:A}; fi
test -f "$source_root/packages/gateway/src/app.ts"
test -s "$source_root/packages/gateway/src/shared/edge/ui-pages/dashboard-app/dist/dashboard.js.txt" || {
  print -u2 "Build the selected dashboard bundle first: cd $source_root && bun run build:ui"
  exit 2
}

runs_parent=${C12_CAPABILITY_RUNS_ROOT:-${TMPDIR:-/tmp}/vnext-c12-capability-runs}
mkdir -p "$runs_parent"
run_dir=$(mktemp -d "$runs_parent/run.XXXXXX")
chmod 700 "$run_dir"
print "C12_RUN_DIR=$run_dir"
cp "$here/fixture.ts.txt" "$run_dir/fixture.ts"
cd "$run_dir"
env -i PATH="$PATH" HOME="$HOME" C12_CAPABILITY_SOURCE_ROOT="$source_root" \
  C12_CAPABILITY_PATH="$capability_path" bun "$run_dir/fixture.ts" > "$run_dir/server.log" 2>&1 &
fixture_pid=$!
cleanup() {
  kill "$fixture_pid" 2>/dev/null || true
  wait "$fixture_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
for attempt in {1..100}; do
  if [[ -s "$run_dir/connection.json" ]]; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat "$run_dir/server.log"; exit 1; fi
  sleep 0.1
done
test -s "$run_dir/connection.json" || { cat "$run_dir/server.log"; exit 1; }
env -i PATH="$PATH" HOME="$HOME" C12_CONNECTION="$run_dir/connection.json" \
  C12_CAPABILITY_BOOLEAN_POINTER="$boolean_pointer" C12_STRUCTURED_ASSERTIONS_FILE="$assertions_file" \
  node "$here/validate.mjs"
