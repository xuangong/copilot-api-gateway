#!/bin/bash
set -euo pipefail
acceptance_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fixture_root=${D10B_CODEX_FIXTURE_ROOT:-$(CDPATH= cd -- "$acceptance_root/../codex-client-runtime" && pwd)}
installed_home=${1:?Pass the temporary installed Codex home parent}
case "$installed_home" in /var/folders/*/T/d10b-root-*/*|/private/var/folders/*/T/d10b-root-*/*) ;; *) printf '%s\n' 'Expected an isolated D10B root fixture home' >&2; exit 1;; esac
run_dir=$(mktemp -d "$fixture_root/runs/d10b-native.XXXXXX")
mkdir -p "$run_dir"/xdg-config "$run_dir"/xdg-cache "$run_dir"/tmp
cd "$fixture_root/source/codex-rs"
env -i PATH=/Users/zhangxian/.cargo/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
 HOME="$installed_home" RUSTUP_HOME=/Users/zhangxian/.rustup \
 CARGO_HOME="$fixture_root/cargo-home" CARGO_TARGET_DIR="$fixture_root/target" CARGO_BUILD_JOBS=4 \
 CODEX_HOME="$installed_home/.codex" XDG_CONFIG_HOME="$run_dir/xdg-config" XDG_CACHE_HOME="$run_dir/xdg-cache" \
 TMPDIR="$run_dir/tmp" RUST_MIN_STACK=16777216 D10B_INSTALLED_CONFIG="$installed_home/.codex/config.toml" \
 cargo test --locked --offline -p codex-core --test all \
 suite::client::d10b_setup_acceptance::installed_setup_provider_parses_and_supplies_bearer -- --exact --ignored --nocapture \
 > "$run_dir/result.log" 2>&1
tail -n 18 "$run_dir/result.log"
printf 'run_dir=%s\n' "$run_dir"
