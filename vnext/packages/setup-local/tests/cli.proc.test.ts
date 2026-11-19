import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { credentialRead, exchangeSetup } from "../src/cli"
import { preflight, targetPath } from "../src/paths"
import { temporaryHome, credential } from "./fixtures"
const runner = join(import.meta.dir, "../../gateway/src/control-plane/setup/dist/runner.mjs")

test("exchange sends bearer only in dedicated header with no body, query or redirect replay", async () => {
  const token = "stl_" + "b".repeat(64)
  const fetcher: typeof fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
    expect(String(input)).toBe("https://gateway.invalid/api/setup/exchange")
    expect(options?.headers).toEqual({ "X-Setup-Lease": token })
    expect(options?.body).toBeUndefined()
    expect(options?.redirect).toBe("error")
    expect(options?.credentials).toBe("omit")
    return Response.json({ fixture: true })
  }, { preconnect: fetch.preconnect })
  expect(await exchangeSetup("https://gateway.invalid", token, fetcher)).toEqual({ fixture: true })
})
test("preflight rejects custom homes and missing Bun before consuming a token", () => {
  const fixture = temporaryHome()
  try {
    expect(() => preflight(fixture.home, { CODEX_HOME: join(fixture.home, "custom") }, process.execPath)).toThrow("Custom")
    expect(() => preflight(fixture.home, { CLAUDE_CONFIG_DIR: "relative" }, process.execPath)).toThrow("Custom")
    expect(() => preflight(fixture.home, {}, join(fixture.home, "missing-bun"))).toThrow("Bun")
  } finally { fixture.cleanup() }
})
test("credential-read prints only a private, bounded allowlisted key and fails closed", async () => {
  const fixture = temporaryHome()
  try {
    mkdirSync(join(fixture.home, ".codex"))
    const token = targetPath(fixture.home, "codex-token")
    writeFileSync(token, credential + "\n", { mode: 0o600 })
    expect(credentialRead(fixture.home, token)).toBe(credential)
    const run = async (path: string) => {
      const child = Bun.spawn([process.execPath, runner, "credential-read", path], { env: fixture.env, stdout: "pipe", stderr: "pipe" })
      return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() }
    }
    expect(await run(token)).toEqual({ code: 0, stdout: credential + "\n", stderr: "" })
    for (const invalid of ["wrong", "x".repeat(66), credential + "\n\n"]) {
      writeFileSync(token, invalid)
      const result = await run(token)
      expect(result.code).not.toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe("Credential helper failed\n")
    }
    writeFileSync(token, credential); chmodSync(token, 0o644)
    expect((await run(token)).code).not.toBe(0)
    chmodSync(token, 0o600)
    const moved = token + ".moved"
    renameSync(token, moved)
    expect((await run(token)).code).not.toBe(0)
    symlinkSync(moved, token)
    expect((await run(token)).code).not.toBe(0)
    expect((await run(moved)).code).not.toBe(0)
    expect(readFileSync(moved, "utf8")).toBe(credential)
  } finally { fixture.cleanup() }
})

test("network uncertainty reports remint guidance without retrying or exposing the bearer", async () => {
  const lease = "stl_" + "b".repeat(64)
  let attempts = 0
  const fetcher: typeof fetch = Object.assign(async () => {
    attempts++
    throw new Error("transport failed after sending " + lease)
  }, { preconnect: fetch.preconnect })
  await expect(exchangeSetup("https://gateway.invalid", lease, fetcher)).rejects.toThrow("outcome is unknown; revoke this lease and mint a new one")
  expect(attempts).toBe(1)
})
