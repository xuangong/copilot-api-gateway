#!/usr/bin/env bash
# Installs, updates or removes the trojan telemetry agent (see docs/telemetry-v1.md).
#
#   curl -fsSL <release>/install.sh | sudo TELEMETRY_GATEWAY='https://gateway.example' TELEMETRY_KEY='tlm_...' bash
#   Further sources on the same VM (websites): TELEMETRY_SITES='source=sni:site,...;...' maps SNIs to sources and each source's push
#   key is stored as TELEMETRY_KEY_<SOURCE> (upper case, dashes as underscores). Either pass that variable directly or run the
#   command with TELEMETRY_SOURCE=<source> and the source's key in TELEMETRY_KEY: the key is then stored for that source and
#   the trojan key, gateway and every other setting already in the env file are kept.
#   (the dashboard's command first verifies this file against a pinned hash and also sets TELEMETRY_AGENT_SHA256, which the
#   downloaded agent must match in addition to SHA256SUMS)
#   curl -fsSL <release>/install.sh | sudo bash -s -- --uninstall [--purge]   (unpinned: nothing verifies the script; for a
#   verified removal download install.sh, check it against the hash in the dashboard's command, then run it with --uninstall)
#
# Test hooks: TELEMETRY_PREFIX is a root directory for every path (and skips root, apt, systemctl and the first run);
# TELEMETRY_BASE_URL replaces the download base (file:// is fine).
set -euo pipefail

VERSION="__TELEMETRY_VERSION__"
BASE_URL="${TELEMETRY_BASE_URL:-}"
PREFIX="${TELEMETRY_PREFIX:-}"
APP_DIR="$PREFIX/opt/trojan-telemetry"
ENV_FILE="$PREFIX/etc/trojan-telemetry.env"
STATE_DIR="$PREFIX/var/lib/trojan-telemetry"
UNIT_DIR="$PREFIX/etc/systemd/system"
OPTIONAL_KEYS="TROJAN_CONTAINER TELEMETRY_IFACE TROJAN_USERS TOP_DOMAINS TROJAN_CONFIG TROJAN_SNI PROBE_HOST PROBE_PORT PROBE_TARGET PROBE_TIMEOUT TELEMETRY_SITES TOP_CLIENTS TOP_CLIENT_DOMAINS GEO_DOWNLOAD"

require_root() {
  if [ -z "$PREFIX" ] && [ "$(id -u)" -ne 0 ]; then die "run as root (for example with sudo)"; fi
}

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# POSIX single quoting, readable back by the agent's env-file parser.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi
}

existing_line() { { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -n 1; } || true; }

# The saved value of an env-file key, unquoted without eval (the quoting written by quote()).
saved_value() {
  local line value q="'" esc
  esc="'\\''"
  line="$(existing_line "$1")"
  value="${line#*=}"
  case "$value" in
    "$q"*"$q") value="${value#"$q"}"; value="${value%"$q"}"; value="${value//"$esc"/$q}" ;;
  esac
  printf '%s' "$value"
}

# Names of the per-source key variables: those in the environment plus those already saved.
source_key_names() {
  {
    compgen -A export | grep -E '^TELEMETRY_KEY_[A-Z0-9_]+$' || true
    { [ -f "$ENV_FILE" ] && grep -oE '^TELEMETRY_KEY_[A-Z0-9_]+' "$ENV_FILE"; } || true
  } | sort -u
}

write_env() {
  local tmp="$ENV_FILE.tmp" key line
  mkdir -p "$(dirname "$ENV_FILE")"
  (
    umask 077
    {
      printf 'TELEMETRY_GATEWAY=%s\n' "$(quote "$TELEMETRY_GATEWAY")"
      printf 'TELEMETRY_KEY=%s\n' "$(quote "$TELEMETRY_KEY")"
      for key in $OPTIONAL_KEYS $(source_key_names); do
        if [ -n "${!key+x}" ]; then
          printf '%s=%s\n' "$key" "$(quote "${!key}")"
        else
          line="$(existing_line "$key")"
          if [ -n "$line" ]; then printf '%s\n' "$line"; fi
        fi
      done
    } > "$tmp"
  )
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

write_units() {
  cat > "$UNIT_DIR/trojan-telemetry.service" <<UNIT
[Unit]
Description=Trojan hourly telemetry push
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$PYTHON $APP_DIR/trojan-telemetry.py run
NoNewPrivileges=yes
PrivateTmp=yes
TimeoutStartSec=50min
UNIT
  cat > "$UNIT_DIR/trojan-telemetry.timer" <<'UNIT'
[Unit]
Description=Run the trojan telemetry agent hourly

[Timer]
OnCalendar=*-*-* *:05:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
}

ensure_vnstat() {
  [ -z "$PREFIX" ] || return 0
  if ! command -v vnstat >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 || die "vnstat is not installed and apt-get is not available; install vnstat first"
    DEBIAN_FRONTEND=noninteractive apt-get install -y vnstat </dev/null
  fi
  systemctl enable --now vnstat >/dev/null 2>&1 || warn "could not start the vnstat service"
}

check_log_rotation() {
  command -v docker >/dev/null 2>&1 || return 0
  local container="${TROJAN_CONTAINER:-}" info
  [ -n "$container" ] || container="$(saved_value TROJAN_CONTAINER)"
  [ -n "$container" ] || container=trojan
  if ! info="$(docker inspect -f '{{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}' "$container" 2>/dev/null)"; then
    warn "docker container '$container' was not found; set TROJAN_CONTAINER if it has another name"
    return 0
  fi
  case "$info" in
    "json-file "*max-size*) ;;
    *) warn "container '$container' has no log rotation (json-file with max-size). Hours whose logs have rotated away cannot be recomputed after an outage. Suggested: max-size 200m, max-file 5 (change the trojan deployment yourself; this installer does not)." ;;
  esac
}

install_agent() {
  case "$VERSION" in
    __*) [ -n "$BASE_URL" ] || die "this install.sh is not a release build (no version stamped); set TELEMETRY_BASE_URL to a built release" ;;
  esac
  BASE_URL="${BASE_URL:-https://github.com/xuangong/copilot-api-gateway/releases/download/telemetry-agent-v$VERSION}"
  local source="${TELEMETRY_SOURCE:-}" key
  case "$source" in
    "") ;;
    trojan-vm) die "TELEMETRY_SOURCE must be a website source name such as museum; trojan-vm is the trojan source itself (leave TELEMETRY_SOURCE unset)" ;;
    *) [[ "$source" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "TELEMETRY_SOURCE must be a lower-case name such as museum" ;;
  esac
  if [ -n "$source" ]; then
    # TELEMETRY_KEY is this source's key: store it under its own name and keep the trojan key and gateway that are already saved.
    [ -n "${TELEMETRY_KEY:-}" ] || die "TELEMETRY_KEY is required"
    case "$TELEMETRY_KEY" in *$'\n'*|*$'\r'*) die "TELEMETRY_KEY must not contain line breaks" ;; esac
    key="TELEMETRY_KEY_$(printf '%s' "$source" | tr 'a-z-' 'A-Z_')"
    export "$key=$TELEMETRY_KEY"
    TELEMETRY_KEY="$(saved_value TELEMETRY_KEY)"
    [ -n "$TELEMETRY_KEY" ] || die "no trojan source is installed yet; run the trojan source's install command first (without TELEMETRY_SOURCE)"
    [ -n "${TELEMETRY_GATEWAY:-}" ] || TELEMETRY_GATEWAY="$(saved_value TELEMETRY_GATEWAY)"
  fi
  [ -n "${TELEMETRY_GATEWAY:-}" ] || die "TELEMETRY_GATEWAY is required"
  [ -n "${TELEMETRY_KEY:-}" ] || die "TELEMETRY_KEY is required"
  if [ -z "$source" ]; then
    # The trojan key is replaced only on purpose: a website source's command pasted without TELEMETRY_SOURCE would otherwise take over the trojan source.
    local saved_key
    saved_key="$(saved_value TELEMETRY_KEY)"
    if [ -n "$saved_key" ] && [ "$saved_key" != "$TELEMETRY_KEY" ] && [ "${TELEMETRY_REPLACE_TROJAN_KEY:-}" != 1 ]; then
      die "a different trojan TELEMETRY_KEY is already installed; this command would replace it. If this is the trojan source's rotated key, run it again with TELEMETRY_REPLACE_TROJAN_KEY=1; for a website source use TELEMETRY_SOURCE=<name>"
    fi
  fi
  case "$TELEMETRY_GATEWAY$TELEMETRY_KEY" in
    *$'\n'*|*$'\r'*) die "TELEMETRY_GATEWAY and TELEMETRY_KEY must not contain line breaks" ;;
  esac
  for key in $OPTIONAL_KEYS $(source_key_names); do
    case "${!key:-}" in
      *$'\n'*|*$'\r'*) die "$key must not contain line breaks" ;;
    esac
  done
  require_root
  if [ -z "$PREFIX" ]; then
    command -v systemctl >/dev/null 2>&1 || die "systemctl was not found; this installer needs a systemd host"
    if ! command -v vnstat >/dev/null 2>&1 && ! command -v apt-get >/dev/null 2>&1; then
      die "vnstat is not installed and apt-get is not available; install vnstat first"
    fi
  fi
  PYTHON="$(command -v python3)" || die "python3 is required"

  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  for name in trojan-telemetry.py SHA256SUMS; do
    curl -fsSL --proto-redir '=https' "$BASE_URL/$name" -o "$work/$name" || die "could not download $name from $BASE_URL"
  done
  local expected
  expected="$(awk '{ name = $2; sub(/^\*/, "", name); if (name == "trojan-telemetry.py") print $1 }' "$work/SHA256SUMS")"
  [ -n "$expected" ] || die "SHA256SUMS has no entry for trojan-telemetry.py"
  local actual pinned
  actual="$(sha256_of "$work/trojan-telemetry.py")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for trojan-telemetry.py; nothing was installed"
  if [ -n "${TELEMETRY_AGENT_SHA256:-}" ]; then
    pinned="$(printf '%s' "$TELEMETRY_AGENT_SHA256" | tr 'A-F' 'a-f')"
    [ "$pinned" = "$actual" ] || die "trojan-telemetry.py does not match the pinned TELEMETRY_AGENT_SHA256; nothing was installed"
  fi

  ensure_vnstat
  mkdir -p "$APP_DIR" "$STATE_DIR" "$UNIT_DIR"
  chmod 700 "$STATE_DIR"
  install -m 755 "$work/trojan-telemetry.py" "$APP_DIR/trojan-telemetry.py"
  write_env
  if [ -n "$source" ] && ! saved_value TELEMETRY_SITES | grep -Eq "(^|;)[[:space:]]*$source[[:space:]]*="; then
    warn "TELEMETRY_SITES does not list $source yet; this source collects nothing until you set it (TELEMETRY_SITES='$source=sni.example:site') and run the installer again"
  fi
  write_units
  if [ -z "$PREFIX" ]; then
    systemctl daemon-reload
    systemctl enable --now trojan-telemetry.timer
  fi
  check_log_rotation

  local status=0
  if [ -z "$PREFIX" ]; then
    say "Running the agent once..."
    "$PYTHON" "$APP_DIR/trojan-telemetry.py" run </dev/null || status=$?
    if [ "$status" -eq 0 ]; then
      say "Initial run finished: the first hours were pushed."
    else
      warn "the initial run failed (exit $status); see 'systemctl status trojan-telemetry.service' and 'journalctl -u trojan-telemetry'"
    fi
  else
    say "Initial run skipped (test prefix)."
  fi
  say "Installed trojan-telemetry $VERSION; the timer runs at minute 5 of every hour."
  say "Note: the key you passed is visible in your shell history and the process list. If that matters, rotate it in the dashboard (Telemetry, rotate key) and run this installer again with the new key."
  return "$status"
}

uninstall_agent() {
  local purge="$1"
  require_root
  if [ -z "$PREFIX" ]; then systemctl disable --now trojan-telemetry.timer >/dev/null 2>&1 || true; fi
  rm -f "$UNIT_DIR/trojan-telemetry.service" "$UNIT_DIR/trojan-telemetry.timer"
  if [ -z "$PREFIX" ]; then systemctl daemon-reload || true; fi
  rm -rf "$APP_DIR"
  rm -f "$ENV_FILE"
  if [ "$purge" = 1 ]; then
    rm -rf "$STATE_DIR"
    say "Removed the agent, its configuration and its state."
  else
    say "Removed the agent and its configuration. State is kept in $STATE_DIR (add --purge to remove it)."
  fi
}

main() {
  local mode=install purge=0 arg
  for arg in "$@"; do
    case "$arg" in
      --uninstall) mode=uninstall ;;
      --purge) purge=1 ;;
      *) die "unknown argument: $arg" ;;
    esac
  done
  if [ "$purge" = 1 ] && [ "$mode" != uninstall ]; then die "--purge only works together with --uninstall"; fi
  if [ "$mode" = uninstall ]; then uninstall_agent "$purge"; else install_agent; fi
}

main "$@"
