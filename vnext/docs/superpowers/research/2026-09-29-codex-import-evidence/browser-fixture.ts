import { resolve } from "node:path"
const sourceRoot = process.env.C08_SOURCE_ROOT
if (!sourceRoot) throw new Error("C08_SOURCE_ROOT required")
const root = resolve(sourceRoot)
let oauthCalls = 0
// This isolated fixture never permits external traffic.
globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input)
  if (new URL(url).pathname.endsWith("/oauth/token")) {
    oauthCalls++
    return Response.json({ access_token: "synthetic-ui-minted", refresh_token: "synthetic-ui-rotated", id_token: "synthetic-id-token", expires_in: 3600, token_type: "Bearer" })
  }
  throw new Error("Unexpected external request in synthetic browser fixture")
}
const { bootstrapBunPlatform } = await import(`${root}/apps/platform-bun/src/bootstrap.ts`)
const { app } = await import(`${root}/packages/gateway/src/app.ts`)
const { getRepo } = await import(`${root}/packages/gateway/src/repo/index.ts`)
bootstrapBunPlatform({ dbPath: `${process.cwd()}/fixture.sqlite`, filesRoot: `${process.cwd()}/files` })
const { initSocketDial } = await import(`${root}/packages/platform/src/index.ts`)
initSocketDial(async () => { throw new Error("External socket blocked by synthetic browser fixture") })
const repo = getRepo()
const now = new Date().toISOString(), ownerId = "00000000-0000-4000-a000-0000000000a1"
const token = `ses_${crypto.randomUUID().replaceAll("-", "")}`
await repo.users.create({ id: ownerId, name: "Synthetic UI Admin", email: "test@local.dev", createdAt: now, disabled: false })
await repo.sessions.create({ token, userId: ownerId, createdAt: now, authenticatedAt: Date.now(), expiresAt: new Date(Date.now()+3600_000).toISOString() })
let snapshot: unknown = null
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
  const url = new URL(request.url)
  if (url.pathname === "/api/models") return Response.json({ object: "list", data: [] })
  if (url.pathname === "/__verify") {
    const rows = (await repo.upstreams.list({ ownerId })).filter(row => row.provider === "codex")
    if (url.searchParams.has("snapshot")) snapshot = structuredClone(rows)
    const baseline = snapshot as typeof rows | null
    return Response.json({ oauthCalls, rows: rows.map(row => {
      const state = row.state as { accounts?: Array<{ openaiDeviceId?: string; credentialRevision?: string; accessToken?: { token: string }; refresh_token?: string }> }
      const original = baseline?.find(value => value.id === row.id)
      const originalState = original?.state as typeof state | undefined
      const account = state.accounts?.[0], first = originalState?.accounts?.[0]
      return { id: row.id, name: row.name, enabled: row.enabled, catalogGeneration: row.catalogGeneration,
        selectedCredential: account?.accessToken?.token === "synthetic-ui-access",
        replacementCredential: account?.accessToken?.token === "synthetic-ui-replacement",
        mintedCredential: account?.accessToken?.token === "synthetic-ui-minted",
        stableInstallation: !!first && account?.openaiDeviceId === first.openaiDeviceId,
        changedRevision: !!first && account?.credentialRevision !== first.credentialRevision,
        sameMetadata: !!original && ["id","name","ownerId","enabled","sortOrder","createdAt","proxyFallbackList","disabledPublicModelIds","flagOverrides"].every(key => JSON.stringify(row[key as keyof typeof row]) === JSON.stringify(original[key as keyof typeof row])),
        initialCatalogGeneration: original?.catalogGeneration,
      }
    }) })
  }
  return app.fetch(request)
} })
await Bun.write(`${process.cwd()}/connection.json`, JSON.stringify({port:server.port,token,pid:process.pid,sourceRoot:root}))
const stop=()=>{server.stop(true);process.exit(0)}
process.once("SIGTERM",stop);process.once("SIGINT",stop)
