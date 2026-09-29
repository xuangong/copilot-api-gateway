#!/bin/sh
# Public, credential-free bootstrap. Bun must already be installed.
set +x
set -eu
umask 077
if [ "$#" -ne 2 ] || [ "$1" != "--origin" ]; then
  printf '%s\n' 'Usage: sh setup.sh --origin https://gateway.example' >&2
  exit 1
fi
origin=$2
bun=$(command -v bun || true)
if [ -z "$bun" ]; then printf '%s\n' 'Bun must already be installed; no lease was consumed.' >&2; exit 1; fi
# Run only fixed local preflight code before downloading/exchanging anything.
"$bun" -e 'const p=require("node:path"); const f=require("node:fs"); const h=f.realpathSync(require("node:os").homedir()); for(const [k,d] of [["CODEX_HOME",".codex"],["CLAUDE_CONFIG_DIR",".claude"]]) if(process.env[k] && p.resolve(process.env[k])!==p.join(h,d) && p.resolve(process.env[k])!==p.join(require("node:os").homedir(),d)) {process.stderr.write("Custom configuration home unsupported; no lease was consumed\n");process.exit(1)}; const s=process.argv[1]; const u=new URL(s); if(!/^https?:\/\/[^/?#\\@\s]+$/.test(s)||u.origin!==s) {process.stderr.write("Invalid gateway origin\n");process.exit(1)}' "$origin"
temporary=$(mktemp -d)
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT HUP INT TERM
curl --fail --silent --show-error --proto '=http,https' --output "$temporary/runner.mjs" "$origin/setup/runner.mjs"
"$bun" -e 'const f=require("node:fs"); const c=require("node:crypto"); const value=c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"); if(value!==process.argv[2]) {process.stderr.write("Setup runner checksum mismatch\n");process.exit(1)}' "$temporary/runner.mjs" '__RUNNER_SHA256__'
if [ -t 0 ]; then
  printf '%s' 'One-use setup token: ' >&2
  previous=$(stty -g)
  trap 'stty "$previous"; cleanup' EXIT HUP INT TERM
  stty -echo
  IFS= read -r lease
  stty "$previous"
  printf '\n' >&2
  trap cleanup EXIT HUP INT TERM
  printf '%s\n' "$lease" | "$bun" "$temporary/runner.mjs" setup --origin "$origin" --platform posix
else
  # Token and optional APPLY confirmation stay on private stdin, never argv.
  "$bun" "$temporary/runner.mjs" setup --origin "$origin" --platform posix
fi
