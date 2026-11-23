/**
 * The agent release this gateway's install command pins. Kept equal to `tools/trojan-telemetry/VERSION` and to the agent's
 * `AGENT_VERSION` by `tests/telemetry-agent-release-consistency.test.ts` and by the release workflow.
 */
export const TELEMETRY_AGENT_VERSION = "1.1.0"
export const TELEMETRY_RELEASE_TAG = `telemetry-agent-v${TELEMETRY_AGENT_VERSION}`
export const TELEMETRY_RELEASE_BASE = `https://github.com/xuangong/copilot-api-gateway/releases/download/${TELEMETRY_RELEASE_TAG}`

/**
 * SHA-256 of `tools/trojan-telemetry/trojan-telemetry.py` as committed (the release copies it unchanged) and of the release's
 * `install.sh` (the committed file with the version stamped by `build-release.sh`). The install command pins both so the bytes a
 * VM runs are the bytes this gateway was built with, whatever the release page serves. Update them with any change to those files;
 * `tests/telemetry-agent-release-consistency.test.ts` recomputes both and the release workflow checks the built assets against them.
 */
export const TELEMETRY_AGENT_SHA256 = "e48cc49df2299e483892fd66f3e9446b799bfab2f3923ed15084635b434932dc"
export const TELEMETRY_INSTALLER_SHA256 = "9b340fb1358284dc806f72b75d267da4bd65cd10f2fb01e34dabdecc06913cd5"

/** POSIX single quoting: safe for any value, including embedded quotes. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** The name a source has in the agent's TELEMETRY_SITES (a website source on the trojan VM); lower case, as the installer requires; `trojan-vm` is the trojan source itself and never one. */
export const AGENT_SOURCE_PATTERN = /^(?!trojan-vm$)[a-z][a-z0-9-]{0,31}$/

/**
 * One copy-pasteable command: download install.sh to a private temp file, verify it against the pinned hash (sha256sum, else
 * shasum), and only then run it as root with the gateway, key and pinned agent hash in its environment. The key is never echoed.
 * With `agentSource` the key belongs to that website source: the installer stores it as `TELEMETRY_KEY_<SOURCE>` and keeps the
 * trojan key, so installing a second or third source on the same VM never replaces the first. The installer refuses to replace a saved,
 * different trojan key unless the owner sets TELEMETRY_REPLACE_TROJAN_KEY=1 by hand; this command never does.
 */
export function installCommand(gatewayOrigin: string, key: string, agentSource?: string): string {
  const source = (agentSource === undefined ? "" : ` TELEMETRY_SOURCE=${shellQuote(agentSource)}`)
  const verify = "if command -v sha256sum >/dev/null 2>&1; then sha256sum -c -; else shasum -a 256 -c -; fi"
  return [
    `( f="$(mktemp)" && trap 'rm -f "$f"' EXIT`,
    `curl -fsSL ${TELEMETRY_RELEASE_BASE}/install.sh -o "$f"`,
    `printf '%s  %s\\n' ${shellQuote(TELEMETRY_INSTALLER_SHA256)} "$f" | { ${verify}; }`,
    `sudo TELEMETRY_GATEWAY=${shellQuote(gatewayOrigin)} TELEMETRY_KEY=${shellQuote(key)}${source} TELEMETRY_AGENT_SHA256=${shellQuote(TELEMETRY_AGENT_SHA256)} bash "$f" )`,
  ].join(" && ")
}
