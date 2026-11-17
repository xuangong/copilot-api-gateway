/**
 * The agent release this gateway's install command pins. Kept equal to `tools/trojan-telemetry/VERSION` and to the agent's
 * `AGENT_VERSION` by `tests/telemetry-agent-release-consistency.test.ts` and by the release workflow.
 */
export const TELEMETRY_AGENT_VERSION = "1.0.0"
export const TELEMETRY_RELEASE_TAG = `telemetry-agent-v${TELEMETRY_AGENT_VERSION}`
export const TELEMETRY_RELEASE_BASE = `https://github.com/xuangong/copilot-api-gateway/releases/download/${TELEMETRY_RELEASE_TAG}`

/**
 * SHA-256 of `tools/trojan-telemetry/trojan-telemetry.py` as committed (the release copies it unchanged) and of the release's
 * `install.sh` (the committed file with the version stamped by `build-release.sh`). The install command pins both so the bytes a
 * VM runs are the bytes this gateway was built with, whatever the release page serves. Update them with any change to those files;
 * `tests/telemetry-agent-release-consistency.test.ts` recomputes both and the release workflow checks the built assets against them.
 */
export const TELEMETRY_AGENT_SHA256 = "58cb8d2fead2ac749ec1df38023e9d267af582ee0ba89860c122527367ca505f"
export const TELEMETRY_INSTALLER_SHA256 = "0af10c5b66ef85312d15d6bfc0b9f15342536356f8d64dfd7e8c937efc7a1a40"

/** POSIX single quoting: safe for any value, including embedded quotes. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * One copy-pasteable command: download install.sh to a private temp file, verify it against the pinned hash (sha256sum, else
 * shasum), and only then run it as root with the gateway, key and pinned agent hash in its environment. The key is never echoed.
 */
export function installCommand(gatewayOrigin: string, key: string): string {
  const verify = "if command -v sha256sum >/dev/null 2>&1; then sha256sum -c -; else shasum -a 256 -c -; fi"
  return [
    `( f="$(mktemp)" && trap 'rm -f "$f"' EXIT`,
    `curl -fsSL ${TELEMETRY_RELEASE_BASE}/install.sh -o "$f"`,
    `printf '%s  %s\\n' ${shellQuote(TELEMETRY_INSTALLER_SHA256)} "$f" | { ${verify}; }`,
    `sudo TELEMETRY_GATEWAY=${shellQuote(gatewayOrigin)} TELEMETRY_KEY=${shellQuote(key)} TELEMETRY_AGENT_SHA256=${shellQuote(TELEMETRY_AGENT_SHA256)} bash "$f" )`,
  ].join(" && ")
}
