import { expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync, symlinkSync, renameSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { envelope, temporaryHome, credential } from "./fixtures"
import type { Client, Platform, Envelope } from "../src/contract"
import { canonicalJson, sha256 } from "../src/contract"
import { targetPath } from "../src/paths"
import { staticSetupCommand } from "../../../apps/dashboard/src/tabs/keys/setup-state"
const assets = join(import.meta.dir, "../../gateway/src/control-plane/setup/dist")
const lease = "stl_" + "b".repeat(64)
const pwsh = Bun.which("pwsh")
if (!pwsh) throw new Error("Setup wrapper fixtures require PowerShell (pwsh) on PATH")
async function fixtureServer(client: Client, platform: Platform, corrupt = false, transform?: (item: Envelope) => Promise<unknown>, downloadFailure = false) {
  const requests: { url: string; header: string | null; body: string }[] = []
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url)
    requests.push({ url: request.url, header: request.headers.get("X-Setup-Lease"), body: await request.text() })
    if (url.pathname === "/setup/setup.sh" || url.pathname === "/setup/setup.ps1") return downloadFailure ? new Response("download failed", { status: 503 }) : new Response(readFileSync(join(assets, url.pathname.endsWith(".sh") ? "setup.sh.txt" : "setup.ps1.txt")))
    if (url.pathname === "/setup/runner.mjs") return new Response(corrupt ? "corrupted" : readFileSync(join(assets, "runner.mjs")))
    if (url.pathname === "/api/setup/exchange") {
      if (request.headers.get("X-Setup-Lease") !== lease) return new Response("unauthorized", { status: 401 })
      const item = await envelope(client, 'opaque-模型-"quote"\nline', url.origin, platform)
      return Response.json(transform ? await transform(item) : item)
    }
    return new Response("not found", { status: 404 })
  } })
  return { server, requests, origin: server.url.origin }
}
for (const platform of ["posix", "windows"] as const) for (const failure of ["download", "missing-bun", "checksum", "cancel", "success"] as const) {
  test(`copied ${platform} command preserves ${failure} outcome and cleans temporary downloads`, async () => {
    const fixture = temporaryHome()
    const remote = await fixtureServer("claude", platform, failure === "checksum", undefined, failure === "download")
    try {
      const temporary = join(fixture.home, "temporary")
      mkdirSync(temporary)
      const env = { ...fixture.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary, ...(failure === "missing-bun" ? { PATH: "/usr/bin:/bin" } : {}) }
      const copied = staticSetupCommand(remote.origin, platform)
      expect(copied.includes(lease)).toBe(false)
      const result = await run(platform === "windows" ? [pwsh, "-NoProfile", "-Command", copied] : ["/bin/sh", "-c", copied], env, lease + (failure === "success" ? "\nAPPLY\n" : "\nNO\n"))
      if (failure === "success") expect(result.code).toBe(0)
      else expect(result.code).not.toBe(0)
      expect(readdirSync(temporary)).toEqual([])
      expect((result.stdout + result.stderr).includes(lease)).toBe(false)
      expect((result.stdout + result.stderr).includes(credential)).toBe(false)
      expect(remote.requests.filter(request => request.header === lease)).toHaveLength(failure === "cancel" || failure === "success" ? 1 : 0)
      expect(remote.requests.every(request => !request.url.includes(lease) && request.body === "")).toBe(true)
      expect(remote.requests.some(request => request.url.endsWith("/setup/runner.mjs"))).toBe(failure !== "download" && failure !== "missing-bun")
      expect(existsSync(join(fixture.home, ".claude"))).toBe(failure === "success")
      if (failure === "missing-bun") expect(result.stderr).toContain("Bun must already be installed")
      if (failure === "checksum") expect(result.stderr).toContain("checksum mismatch")
      if (failure === "cancel") expect(result.stderr).toContain("Setup cancelled")
    } finally { remote.server.stop(true); fixture.cleanup() }
  }, 45_000)
}

for (const previous of ["Authorization: Bearer previous-authorization-secret", "x-api-key: previous-api-key-secret"]) {
  for (const selection of ["effort", "context"] as const) for (const mode of ["dry-run", "cancel"] as const) test(`CLI ${mode} hides previous ${previous.split(":")[0]} custom headers for ${selection}`, async () => {
    const fixture = temporaryHome()
    const remote = await fixtureServer("claude", "posix", false, async item => {
      if (item.artifact.kind !== "claude-settings") throw new Error("fixture")
      item.artifact.settings.env.ANTHROPIC_CUSTOM_HEADERS = selection === "effort" ? "x-copilot-reasoning-effort: high" : "anthropic-beta: context-1m-2025-08-07"
      if (selection === "effort") item.artifact.settings.effortLevel = "high"
      const { artifactDigest: _digest, ...body } = item
      return { ...body, artifactDigest: await sha256(canonicalJson(body)) }
    })
    try {
      mkdirSync(join(fixture.home, ".claude"))
      const path = targetPath(fixture.home, "claude-settings")
      const original = JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: previous, KEEP: "unmanaged" }, nested: { keep: true } })
      writeFileSync(path, original)
      const result = await run([process.execPath, join(assets, "runner.mjs"), "setup", "--origin", remote.origin, "--platform", "posix", ...(mode === "dry-run" ? ["--dry-run"] : [])], fixture.env, lease + "\nNO\n")
      expect(result.code).toBe(mode === "dry-run" ? 0 : 1)
      expect((result.stdout + result.stderr).includes(previous)).toBe(false)
      expect((result.stdout + result.stderr).includes(credential)).toBe(false)
      expect((result.stdout + result.stderr).includes(lease)).toBe(false)
      expect(result.stdout).toContain("[REDACTED]")
      expect(readFileSync(path, "utf8") === original).toBe(true)
      expect(readdirSync(join(fixture.home, ".claude"))).toEqual(["settings.json"])
    } finally { remote.server.stop(true); fixture.cleanup() }
  })
}

test("CLI rejects non-string protocol fields with valid digests before preview or writes", async () => {
  for (const field of ["client", "platform", "effortLevel", "ANTHROPIC_CUSTOM_HEADERS"] as const) for (const shape of ["array", "object", "null", "number"] as const) {
    const fixture = temporaryHome()
    const remote = await fixtureServer(field === "client" || field === "platform" ? "codex" : "claude", "posix", false, async item => {
      const text = { client: "codex", platform: "posix", effortLevel: "high", ANTHROPIC_CUSTOM_HEADERS: "anthropic-beta: context-1m-2025-08-07" }[field]
      const value = shape === "array" ? [text] : shape === "object" ? { value: text } : shape === "null" ? null : 1
      const body: Record<string, unknown> = { version: item.version, client: item.client, platform: item.platform, artifact: item.artifact }
      if (field === "client" || field === "platform") body[field] = value
      else if (item.artifact.kind === "claude-settings") {
        if (field === "effortLevel") {
          Object.assign(item.artifact.settings, { effortLevel: value })
          item.artifact.settings.env.ANTHROPIC_CUSTOM_HEADERS = "x-copilot-reasoning-effort: high"
        } else Object.assign(item.artifact.settings.env, { ANTHROPIC_CUSTOM_HEADERS: value })
      }
      return { ...body, artifactDigest: await sha256(canonicalJson(body)) }
    })
    try {
      const result = await run([process.execPath, join(assets, "runner.mjs"), "setup", "--origin", remote.origin, "--platform", "posix"], fixture.env)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe("")
      expect((result.stdout + result.stderr).includes(credential)).toBe(false)
      expect(readdirSync(fixture.home)).toEqual([])
    } finally { remote.server.stop(true); fixture.cleanup() }
  }
}, 20_000)
async function run(command: string[], env: Record<string, string | undefined>, input = lease + "\nAPPLY\n") {
  const child = Bun.spawn(command, { env, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, stdout, stderr }
}
for (const shell of ["sh", "bash", "pwsh"] as const) for (const client of ["claude", "codex"] as const) {
  test(`${shell} wrapper executes ${client} setup under a temporary home`, async () => {
    const fixture = temporaryHome()
    const remote = await fixtureServer(client, shell === "pwsh" ? "windows" : "posix")
    try {
      const script = join(fixture.home, shell === "pwsh" ? "setup.ps1" : "setup.sh")
      writeFileSync(script, readFileSync(join(assets, shell === "pwsh" ? "setup.ps1.txt" : "setup.sh.txt")), { mode: 0o600 })
      const command = shell === "pwsh" ? [pwsh, "-NoProfile", "-File", script, "-Origin", remote.origin] : ["/bin/" + shell, script, "--origin", remote.origin]
      const result = await run(command, fixture.env)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain("Setup complete")
      expect(result.stdout + result.stderr).not.toContain(credential)
      expect(result.stdout + result.stderr).not.toContain(lease)
      expect(remote.requests.filter(request => request.header === lease)).toHaveLength(1)
      expect(remote.requests.every(request => !request.url.includes(lease) && request.body === "")).toBe(true)
      if (client === "codex") {
        const config = Bun.TOML.parse(readFileSync(targetPath(fixture.home, "codex-config"), "utf8")) as { model_providers: { copilot_gateway: { auth: { command: string; args: string[] } } } }
        const auth = config.model_providers.copilot_gateway.auth
        expect(await run([auth.command, ...auth.args], fixture.env, "")).toEqual({ code: 0, stdout: credential + "\n", stderr: "" })
        expect(existsSync(join(fixture.home, ".codex/auth.json"))).toBe(false)
      } else expect(JSON.parse(readFileSync(targetPath(fixture.home, "claude-settings"), "utf8"))).toMatchObject({ env: { ANTHROPIC_AUTH_TOKEN: credential } })
    } finally { remote.server.stop(true); fixture.cleanup() }
  }, 45_000)
}
for (const shell of ["sh", "pwsh"] as const) test(`${shell} rejects custom homes, absent Bun and runner mismatch before exchange`, async () => {
  const fixture = temporaryHome()
  const remote = await fixtureServer("codex", shell === "pwsh" ? "windows" : "posix", true)
  try {
    const script = join(fixture.home, shell === "pwsh" ? "setup.ps1" : "setup.sh")
    writeFileSync(script, readFileSync(join(assets, shell === "pwsh" ? "setup.ps1.txt" : "setup.sh.txt")))
    const command = shell === "pwsh" ? [pwsh, "-NoProfile", "-File", script, "-Origin", remote.origin] : ["/bin/sh", script, "--origin", remote.origin]
    expect((await run(command, { ...fixture.env, CODEX_HOME: join(fixture.home, "custom") })).code).not.toBe(0)
    expect(remote.requests).toHaveLength(0)
    expect((await run(command, { ...fixture.env, PATH: "/usr/bin:/bin" })).code).not.toBe(0)
    expect(remote.requests).toHaveLength(0)
    expect((await run(command, fixture.env)).code).not.toBe(0)
    expect(remote.requests.some(request => request.url.endsWith("/api/setup/exchange"))).toBe(false)
    expect(existsSync(join(fixture.home, ".codex"))).toBe(false)
  } finally { remote.server.stop(true); fixture.cleanup() }
}, 45_000)

for (const aliasKind of ["symlink", "var-alias"] as const) test(`installed helper and dry-run use canonical home with ${aliasKind}`, async () => {
  const fixture = temporaryHome()
  const remote = await fixtureServer("codex", "posix")
  try {
    const alias = aliasKind === "var-alias" ? fixture.home.replace(/^\/private\/var\//, "/var/") : join(fixture.home, "home-alias")
    if (aliasKind === "symlink") symlinkSync(fixture.home, alias)
    const env = { ...fixture.env, HOME: alias, USERPROFILE: alias, CODEX_HOME: join(alias, ".codex"), CLAUDE_CONFIG_DIR: join(alias, ".claude") }
    const args = [process.execPath, join(assets, "runner.mjs"), "setup", "--origin", remote.origin, "--platform", "posix"]
    const dry = await run([...args, "--dry-run"], env, lease + "\n")
    expect(dry.code, dry.stderr).toBe(0)
    expect(dry.stdout).toContain("Dry run complete")
    expect(dry.stdout + dry.stderr).not.toContain(credential)
    expect(existsSync(join(fixture.home, ".codex"))).toBe(false)
    const installed = await run(args, env)
    expect(installed.code, installed.stderr).toBe(0)
    const config = Bun.TOML.parse(readFileSync(targetPath(fixture.home, "codex-config"), "utf8")) as { model_providers: { copilot_gateway: { auth: { command: string; args: string[] } } } }
    const auth = config.model_providers.copilot_gateway.auth
    expect((await run([auth.command, ...auth.args], env, "")).stdout).toBe(credential + "\n")
    const runner = targetPath(fixture.home, "codex-runner")
    renameSync(runner, runner + ".moved")
    const missing = await run([auth.command, ...auth.args], env, "")
    expect(missing.code).not.toBe(0)
    expect(missing.stdout).toBe("")
    expect(() => Bun.spawn([join(fixture.home, "missing-bun"), ...auth.args], { env })).toThrow()
  } finally { remote.server.stop(true); fixture.cleanup() }
}, 20_000)

test("CLI cancellation consumes once and leaves home untouched", async () => {
  const fixture = temporaryHome()
  const remote = await fixtureServer("claude", "posix")
  try {
    const result = await run([process.execPath, join(assets, "runner.mjs"), "setup", "--origin", remote.origin, "--platform", "posix"], fixture.env, lease + "\nNO\n")
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("lease was consumed")
    expect(existsSync(join(fixture.home, ".claude"))).toBe(false)
    expect(remote.requests.filter(request => request.header === lease)).toHaveLength(1)
  } finally { remote.server.stop(true); fixture.cleanup() }
})

const codex = process.env.SETUP_TEST_CODEX
test.skipIf(!codex)("installed native Codex parses the generated provider configuration without starting an agent", async () => {
  if (!codex) throw new Error("Codex executable unavailable")
  const fixture = temporaryHome()
  const remote = await fixtureServer("codex", "posix")
  try {
    const setup = await run([process.execPath, join(assets, "runner.mjs"), "setup", "--origin", remote.origin, "--platform", "posix"], fixture.env)
    expect(setup.code, setup.stderr).toBe(0)
    const parsed = await run([codex, "features", "list"], fixture.env, "")
    expect(parsed.code, parsed.stderr).toBe(0)
    expect(parsed.stdout).not.toContain(credential)
    expect(parsed.stderr).not.toContain(credential)
    expect(existsSync(join(fixture.home, ".codex/auth.json"))).toBe(false)
  } finally { remote.server.stop(true); fixture.cleanup() }
}, 20_000)
