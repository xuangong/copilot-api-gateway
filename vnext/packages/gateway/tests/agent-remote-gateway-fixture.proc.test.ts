import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

interface FixtureReady {
  url: string
  issuer: string
  accounts: { subject: string; sessionToken: string }[]
}
const secret = "local-fixture-only-signing-secret-32-bytes"
const relay = "https://relay.example"
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

test("standalone Gateway fixture serves simulated accounts and Host keys over a free HTTP port", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-remote-fixture-"))
  const readyFile = join(directory, "ready.json")
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/agent-remote-gateway.ts", import.meta.url))], {
    env: { ...process.env, PORT: "0", AGENT_REMOTE_READY_FILE: readyFile, AGENT_REMOTE_ISSUER: "", AGENT_REMOTE_FIXTURE_DOCKER: "",
      AGENT_REMOTE_RELAY_URL: relay, AGENT_REMOTE_SIGNING_SECRET: secret },
    stdout: "ignore", stderr: "pipe",
  })
  try {
    const deadline = Date.now() + 5000
    while (!await Bun.file(readyFile).exists()) {
      if (child.exitCode !== null) throw new Error(`Fixture exited: ${await new Response(child.stderr).text()}`)
      if (Date.now() >= deadline) throw new Error("Fixture readiness deadline exceeded")
      await Bun.sleep(20)
    }
    const ready = await Bun.file(readyFile).json() as FixtureReady
    expect(new URL(ready.url).port).not.toBe("0")
    expect(ready.issuer).toBe(new URL(ready.url).origin)
    expect(ready.accounts).toHaveLength(2)
    const credentials: string[] = []
    for (const account of ready.accounts) {
      const launch = await fetch(new URL("/api/agent-remote/launch", ready.url), {
        method: "POST", headers: { authorization: `Bearer ${account.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ challenge: "n".repeat(43) }), signal: AbortSignal.timeout(2000),
      })
      expect(launch.status).toBe(200)
      const launched = await launch.json() as { launchUrl: string }
      const ticket = new URLSearchParams(new URL(launched.launchUrl).hash.slice(1)).get("ticket")
      const claims = JSON.parse(Buffer.from(ticket?.split(".")[1] ?? "", "base64url").toString()) as { sub: string; iss: string }
      expect(claims).toMatchObject({ sub: account.subject, iss: ready.issuer })
      const body = JSON.stringify({ subject: account.subject, hostId: "test-host", hostName: "Test Docker Host" })
      const now = Math.floor(Date.now() / 1000)
      const bodyHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("base64url")
      const input = `${encode({ alg: "HS256", typ: "arc-relay-service+jwt" })}.${encode({ iss: relay, aud: ready.issuer, op: "host-key", bodyHash, iat: now, exp: now + 60 })}`
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      const proof = `${input}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))).toString("base64url")}`
      const response = await fetch(new URL("/api/agent-remote/host-key", ready.url), {
        method: "POST", body, headers: { authorization: `Bearer ${proof}`, "content-type": "application/json" }, signal: AbortSignal.timeout(2000),
      })
      expect(response.status).toBe(200)
      const issued = await response.json() as { apiKey: string; baseUrl: string }
      expect(issued.baseUrl).toBe(`${ready.issuer}/v1`)
      credentials.push(issued.apiKey)
    }
    expect(new Set(credentials).size).toBe(2)
  } finally {
    child.kill("SIGTERM")
    await child.exited
    rmSync(directory, { recursive: true, force: true })
  }
}, 10_000)
