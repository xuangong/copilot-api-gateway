import { resolve } from "node:path"
const sourceRoot = process.env.C08_SOURCE_ROOT
if (!sourceRoot) throw new Error("C08_SOURCE_ROOT required")
const root = resolve(sourceRoot)
const { bootstrapBunPlatform } = await import(`${root}/apps/platform-bun/src/bootstrap.ts`)
const { app } = await import(`${root}/packages/gateway/src/app.ts`)
const { getRepo } = await import(`${root}/packages/gateway/src/repo/index.ts`)
bootstrapBunPlatform({ dbPath: `${process.cwd()}/fixture.sqlite`, filesRoot: `${process.cwd()}/files` })
const repo = getRepo()
const now = new Date().toISOString(), ownerId = "00000000-0000-4000-a000-0000000000a1"
const token = `ses_${crypto.randomUUID().replaceAll("-", "")}`
await repo.users.create({ id: ownerId, name: "Synthetic UI Admin", email: "test@local.dev", createdAt: now, disabled: false })
await repo.sessions.create({ token, userId: ownerId, createdAt: now, authenticatedAt: Date.now(), expiresAt: new Date(Date.now() + 3600_000).toISOString() })
const fixtures = [
  { provider: "codex", config: { accounts: [{ email: "synthetic@example.invalid", chatgptAccountId: "synthetic-account", chatgptUserId: "synthetic-user", planType: "pro" }] }, state: { accounts: [{ chatgptAccountId: "synthetic-account", refresh_token: "SYNTHETIC_C08_PRIVATE_REFRESH", state: "active", state_updated_at: now, openaiDeviceId: "synthetic-device", accessToken: { token: "SYNTHETIC_C08_PRIVATE_ACCESS", expiresAt: Date.now()+3600_000, refreshedAt: now }, quotaSnapshot: null }] } },
  { provider: "claude-code", config: { accounts: [{ email: null, accountUuid: "synthetic-account", organizationUuid: null, subscriptionType: "pro", rateLimitTier: "default" }] }, state: { accounts: [{ accountUuid: "synthetic-account", tokenKind: "setup-token", refreshToken: null, state: "active", stateUpdatedAt: now, accessToken: { token: "SYNTHETIC_C08_PRIVATE_ACCESS", expiresAt: Date.now()+3600_000, refreshedAt: now }, quotaSnapshot: null, usageProbeSnapshot: null }] } },
]
for (const fixture of fixtures) await repo.upstreams.save({ ...fixture, id: `up_c08_${fixture.provider}`, ownerId, name: `C08 ${fixture.provider}`, enabled: false, sortOrder: 0, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: now, updatedAt: now })
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
  if (new URL(request.url).pathname === "/__verify") {
    const results = await Promise.all(fixtures.map(async fixture => {
      const row = await repo.upstreams.getById(`up_c08_${fixture.provider}`)
      return { provider: fixture.provider, name: row?.name, statePreserved: JSON.stringify(row?.state) === JSON.stringify(fixture.state), configPreserved: JSON.stringify(row?.config) === JSON.stringify(fixture.config) }
    }))
    return Response.json(results)
  }
  return app.fetch(request)
} })
await Bun.write(`${process.cwd()}/connection.json`, JSON.stringify({ port: server.port, token, pid: process.pid, sourceRoot: root }))
const stop = () => { server.stop(true); process.exit(0) }
process.once("SIGTERM", stop)
process.once("SIGINT", stop)
