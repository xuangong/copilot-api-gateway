#!/usr/bin/env bash
# Builds the release assets: build-release.sh <version> <outdir>
# The version must equal VERSION and AGENT_VERSION in trojan-telemetry.py. The installer's version placeholder is stamped.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="${1:-}"
outdir="${2:-}"

if [ -z "$version" ] || [ -z "$outdir" ]; then
  echo "usage: build-release.sh <version> <outdir>" >&2
  exit 2
fi
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "version must look like 1.2.3" >&2
  exit 2
fi
if [ "$(tr -d '[:space:]' < "$here/VERSION")" != "$version" ]; then
  echo "VERSION does not match $version" >&2
  exit 1
fi
if ! grep -q "^AGENT_VERSION = \"$version\"\$" "$here/trojan-telemetry.py"; then
  echo "AGENT_VERSION in trojan-telemetry.py does not match $version" >&2
  exit 1
fi

mkdir -p "$outdir"
cp "$here/trojan-telemetry.py" "$outdir/trojan-telemetry.py"
sed "s/__TELEMETRY_VERSION__/$version/" "$here/install.sh" > "$outdir/install.sh"
chmod 755 "$outdir/install.sh"
if ! grep -q "^VERSION=\"$version\"\$" "$outdir/install.sh"; then
  echo "failed to stamp the version into install.sh" >&2
  exit 1
fi
(
  cd "$outdir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum trojan-telemetry.py install.sh > SHA256SUMS
  else
    shasum -a 256 trojan-telemetry.py install.sh > SHA256SUMS
  fi
)
echo "built telemetry agent $version in $outdir"
