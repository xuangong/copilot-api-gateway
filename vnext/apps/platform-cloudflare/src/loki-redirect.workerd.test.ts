import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"

const here = dirname(fileURLToPath(import.meta.url))
let dir: string
let mf: Miniflare

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "loki-redirect-workerd-"))
  const entry = join(dir, "entry.ts")
  const bundle = join(dir, "worker.mjs")
  writeFileSync(entry, `
    import { LokiProvider } from ${JSON.stringify(join(here, "../../../packages/provider-loki/src/provider.ts"))}
    const account = { homeAccountId: "fixture", tenantId: "11111111-1111-4111-8111-111111111111" }
    const models = { data: [{ id: "fixture", supported_endpoints: ["/v1/messages", "/responses", "/chat/completions"] }] }
    export default { async fetch(request) {
      const params = new URL(request.url).searchParams
      const row = { id: "up_loki_fixture", provider: "loki", ownerId: "fixture", name: "Fixture", enabled: true,
        rowIncarnation: "fixture", credentialGeneration: 0, catalogGeneration: 0, config: { profileId: "loki-df-v1" },
        state: { version: 1, profileId: "loki-df-v1", generation: "fixture", revision: 1, syncSecretHash: "fixture",
          assistantStatus: "authorized", account, credential: { accessToken: "fixture-token", tokenType: "Bearer",
            account, expiresAt: Date.now() + 60000 } } }
      const provider = new LokiProvider(row, async () => row, (url, init) => {
        const headers = new Headers(init.headers)
        headers.set("x-fixture-status", params.get("status") || "200")
        return fetch(url, { ...init, headers })
      })
      provider.setModelCatalog(models)
      try {
        if (params.get("operation") === "models") return Response.json(await provider.getModels())
        const result = await provider.fetch({ endpoint: params.get("operation"), sourceApi: "anthropic", headers: new Headers(),
          payload: { model: "fixture", messages: [{ role: "user", content: "fixture" }], input: "fixture" } })
        return new Response(result.body, { status: result.status, headers: result.headers })
      } catch (error) { return Response.json({ error: error.message }, { status: 502 }) }
    } }
  `)
  const build = Bun.spawnSync(["bun", "build", entry, "--target=node", `--outfile=${bundle}`])
  if (build.exitCode !== 0) throw new Error(new TextDecoder().decode(build.stderr))
  mf = new Miniflare({ host: "127.0.0.1", port: 0, workers: [
    { name: "provider", modules: true, modulesRoot: dir, scriptPath: bundle,
      compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"], outboundService: "upstream" },
    { name: "upstream", modules: true, script: `export default { fetch(request) {
      if (new URL(request.url).hostname !== "df.loki.delve.office.com") return new Response("redirect followed")
      const status = Number(request.headers.get("x-fixture-status"))
      if (status !== 200) return new Response("redirect-body", { status, headers: { location: "https://redirect.invalid/secret" } })
      if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [
        { id: "fixture", supported_endpoints: ["/v1/messages", "/responses", "/chat/completions"] }
      ] })
      return new Response("fixture inference")
    } }` },
  ] })
  await mf.ready
})

afterAll(async () => {
  await mf?.dispose()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

for (const operation of ["models", "messages", "responses", "chat_completions"]) {
  test.serial(`workerd accepts Loki ${operation} fetch options`, async () => {
    const response = await mf.dispatchFetch(`http://fixture/?operation=${operation}`)
    const body = await response.text()
    expect(response.status, body).toBe(200)
    expect(body).toContain(operation === "models" ? '"id":"fixture"' : "fixture inference")
  })

  for (const status of [301, 302, 303, 307, 308]) {
    test.serial(`Loki ${operation} rejects HTTP ${status} without following or forwarding its redirect`, async () => {
      const response = await mf.dispatchFetch(`http://fixture/?operation=${operation}&status=${status}`)
      const body = await response.text()
      expect(response.status).toBe(502)
      expect(body).toContain(operation === "models" ? `loki_catalog_http_${status}` : "loki_redirect_disallowed")
      expect(response.headers.get("location")).toBeNull()
      expect(body).not.toContain("redirect-body")
      expect(body).not.toContain("redirect followed")
    })
  }
}
