import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  TELEMETRY_AGENT_SHA256, TELEMETRY_AGENT_VERSION, TELEMETRY_INSTALLER_SHA256, TELEMETRY_RELEASE_BASE, TELEMETRY_RELEASE_TAG, installCommand, shellQuote,
} from "../src/control-plane/telemetry/agent-release"

test("shell quoting wraps values in single quotes and escapes embedded quotes", () => {
  expect(shellQuote("plain")).toBe("'plain'")
  expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  expect(shellQuote("a b$c`d\"e")).toBe("'a b$c`d\"e'")
})

test("the pinned hashes are SHA-256 hex digests", () => {
  expect(TELEMETRY_AGENT_SHA256).toMatch(/^[0-9a-f]{64}$/)
  expect(TELEMETRY_INSTALLER_SHA256).toMatch(/^[0-9a-f]{64}$/)
})

test("the install command downloads, verifies the pinned installer hash, then runs it with the quoted gateway, key and agent hash", () => {
  const key = `tlm_${"a".repeat(64)}`
  const command = installCommand("https://gw.example", key)
  expect(TELEMETRY_RELEASE_TAG).toBe(`telemetry-agent-v${TELEMETRY_AGENT_VERSION}`)
  expect(command).not.toContain("\n")
  expect(command).not.toMatch(/curl[^&]*\|/)
  const download = command.indexOf(`curl -fsSL ${TELEMETRY_RELEASE_BASE}/install.sh -o "$f"`)
  const verify = command.indexOf(`'${TELEMETRY_INSTALLER_SHA256}'`)
  const run = command.indexOf("sudo ")
  expect(download).toBeGreaterThan(-1)
  expect(verify).toBeGreaterThan(download)
  expect(run).toBeGreaterThan(verify)
  expect(command).toContain("sha256sum -c -")
  expect(command).toContain("shasum -a 256 -c -")
  expect(command).toContain(`sudo TELEMETRY_GATEWAY='https://gw.example' TELEMETRY_KEY='${key}' TELEMETRY_AGENT_SHA256='${TELEMETRY_AGENT_SHA256}' bash "$f"`)
  expect(command).not.toContain("echo")
  expect(command.split(key)).toHaveLength(2)
})

function runCommand(installer: Buffer, shell: string): { code: number; ran: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "install-cmd-"))
  try {
    const stub = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755) }
    writeFileSync(join(dir, "payload"), installer)
    stub("curl", `while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done; cp "${dir}/payload" "$out"`)
    stub("sudo", `touch "${dir}/ran"`)
    const done = Bun.spawnSync([shell, "-c", installCommand("https://gw.example", "tlm_fake")], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
    return { code: done.exitCode, ran: existsSync(join(dir, "ran")) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const shells = ["bash", "sh", "zsh", "dash"].filter(name => Bun.which(name) !== null)

for (const shell of shells) {
  test(`the install command runs the installer only when the downloaded file matches the pinned hash (${shell})`, () => {
    const source = readFileSync(fileURLToPath(new URL("../../../tools/trojan-telemetry/install.sh", import.meta.url)))
    const version = readFileSync(fileURLToPath(new URL("../../../tools/trojan-telemetry/VERSION", import.meta.url)), "utf8").trim()
    const placeholder = Buffer.from("__TELEMETRY_VERSION__")
    const at = source.indexOf(placeholder)
    const stamped = Buffer.concat([source.subarray(0, at), Buffer.from(version), source.subarray(at + placeholder.length)])
    expect(createHash("sha256").update(stamped).digest("hex")).toBe(TELEMETRY_INSTALLER_SHA256)
    expect(runCommand(stamped, shell)).toEqual({ code: 0, ran: true })
    const tampered = runCommand(Buffer.concat([stamped, Buffer.from("\n# tampered\n")]), shell)
    expect(tampered.code).not.toBe(0)
    expect(tampered.ran).toBe(false)
  })
}

test("bash and sh are always exercised", () => {
  expect(shells).toContain("bash")
  expect(shells).toContain("sh")
})
