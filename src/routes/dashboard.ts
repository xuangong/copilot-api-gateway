// Dashboard API routes - copilot-quota, token-usage, latency, export, import
import { Elysia } from "elysia"
import { getRepo, type ApiKey, type GitHubAccount, type UsageRecord, type LatencyRecord } from "~/repo"
import { getGithubCredentials } from "~/lib/github"
import { createGithubHeaders } from "~/config/constants"

interface AuthCtx {
  isAdmin?: boolean
  isUser?: boolean
  userId?: string
  apiKeyId?: string
}

interface ExportPayload {
  version: 1
  exportedAt: string
  data: {
    apiKeys: ApiKey[]
    githubAccounts: GitHubAccount[]
    activeGithubAccountId: number | null
    usage: UsageRecord[]
  }
}

/** Get key IDs for the current user (owned + assigned, for scoping usage/latency queries) */
async function getUserKeyIds(userId: string): Promise<string[]> {
  const repo = getRepo()
  const [ownKeys, assignments] = await Promise.all([
    repo.apiKeys.listByOwner(userId),
    repo.keyAssignments.listByUser(userId),
  ])
  const ids = new Set(ownKeys.map(k => k.id))
  for (const a of assignments) ids.add(a.keyId)
  return [...ids]
}

/** Get all keys accessible to the current user (owned + assigned, for name resolution) */
async function getUserKeys(userId: string): Promise<ApiKey[]> {
  const repo = getRepo()
  const [ownKeys, assignments] = await Promise.all([
    repo.apiKeys.listByOwner(userId),
    repo.keyAssignments.listByUser(userId),
  ])
  const keyMap = new Map(ownKeys.map(k => [k.id, k]))
  if (assignments.length > 0) {
    const assignedKeys = await Promise.all(
      assignments.filter(a => !keyMap.has(a.keyId)).map(a => repo.apiKeys.getById(a.keyId))
    )
    for (const k of assignedKeys) {
      if (k) keyMap.set(k.id, k)
    }
  }
  return [...keyMap.values()]
}

export const dashboardRoute = new Elysia({ prefix: "/api" })
  // GET /api/copilot-quota - fetch Copilot usage/quota info from GitHub API
  .get("/copilot-quota", async (ctx) => {
    const { userId } = ctx as unknown as AuthCtx
    try {
      const { token: githubToken } = await getGithubCredentials(userId)
      const resp = await fetch("https://api.github.com/copilot_internal/user", {
        headers: createGithubHeaders(githubToken),
      })

      if (!resp.ok) {
        const text = await resp.text()
        return new Response(JSON.stringify({ error: `GitHub API error: ${resp.status} ${text}` }), {
          status: resp.status,
          headers: { "Content-Type": "application/json" },
        })
      }

      return resp.json()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(JSON.stringify({ error: msg }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    }
  })

  // GET /api/token-usage - query per-key token usage records
  .get("/token-usage", async (ctx) => {
    const { query } = ctx
    const { isAdmin, userId } = ctx as unknown as AuthCtx
    const keyId = query.key_id || undefined
    const start = query.start ?? ""
    const end = query.end ?? ""

    if (!start || !end) {
      return new Response(
        JSON.stringify({ error: "start and end query parameters are required (e.g. 2026-03-09T00)" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const repo = getRepo()

    // Scope query to user's keys if not admin
    let queryOpts: { keyId?: string; keyIds?: string[]; start: string; end: string }
    let keys: ApiKey[]

    if (isAdmin) {
      queryOpts = { keyId, start, end }
      keys = await repo.apiKeys.list()
    } else if (userId) {
      const userKeys = await getUserKeys(userId)
      if (userKeys.length === 0) return []
      queryOpts = { keyIds: userKeys.map(k => k.id), start, end }
      keys = userKeys
    } else {
      queryOpts = { keyId, start, end }
      keys = await repo.apiKeys.list()
    }

    const records = await repo.usage.query(queryOpts)
    const nameMap = new Map(keys.map((k) => [k.id, k.name]))

    // For admin: enrich with owner info so frontend can group by user
    if (isAdmin) {
      const ownerIdMap = new Map(keys.map((k) => [k.id, k.ownerId]))
      const userIds = new Set(keys.map((k) => k.ownerId).filter(Boolean) as string[])
      const users = await Promise.all([...userIds].map((id) => repo.users.getById(id)))
      const userNameMap = new Map<string, string>()
      for (const u of users) {
        if (u) userNameMap.set(u.id, u.name)
      }
      return records.map((r) => {
        const ownerId = ownerIdMap.get(r.keyId)
        return {
          ...r,
          keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
          ownerId: ownerId ?? '',
          ownerName: ownerId ? (userNameMap.get(ownerId) ?? '') : '',
        }
      })
    }

    return records.map((r) => ({
      ...r,
      keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
    }))
  })

  // GET /api/latency - query per-key latency records
  .get("/latency", async (ctx) => {
    const { query } = ctx
    const { isAdmin, userId } = ctx as unknown as AuthCtx
    const keyId = query.key_id || undefined
    const start = query.start ?? ""
    const end = query.end ?? ""

    if (!start || !end) {
      return new Response(
        JSON.stringify({ error: "start and end query parameters are required (e.g. 2026-03-09T00)" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const repo = getRepo()

    let queryOpts: { keyId?: string; keyIds?: string[]; start: string; end: string }
    let keys: ApiKey[]

    if (isAdmin) {
      queryOpts = { keyId, start, end }
      keys = await repo.apiKeys.list()
    } else if (userId) {
      const userKeys = await getUserKeys(userId)
      if (userKeys.length === 0) return []
      queryOpts = { keyIds: userKeys.map(k => k.id), start, end }
      keys = userKeys
    } else {
      queryOpts = { keyId, start, end }
      keys = await repo.apiKeys.list()
    }

    const records = await repo.latency.query(queryOpts)
    const nameMap = new Map(keys.map((k) => [k.id, k.name]))
    return records.map((r) => ({
      ...r,
      keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
    }))
  })

  // GET /api/export - dump all data as JSON (admin only)
  .get("/export", async (ctx) => {
    const { isAdmin } = ctx as unknown as AuthCtx
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const repo = getRepo()
    const [apiKeys, githubAccounts, activeGithubAccountId, usage] = await Promise.all([
      repo.apiKeys.list(),
      repo.github.listAccounts(),
      repo.github.getActiveId(),
      repo.usage.listAll(),
    ])

    const payload: ExportPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      data: { apiKeys, githubAccounts, activeGithubAccountId, usage },
    }

    return payload
  })

  // POST /api/import - import data with merge or replace mode (admin only)
  .post("/import", async (ctx) => {
    const { body } = ctx
    const { isAdmin } = ctx as unknown as AuthCtx
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const { mode, data } = body as { mode: string; data: Record<string, unknown> }

    if (mode !== "merge" && mode !== "replace") {
      return new Response(JSON.stringify({ error: "mode must be 'merge' or 'replace'" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (!data || typeof data !== "object") {
      return new Response(JSON.stringify({ error: "data is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    const repo = getRepo()
    const apiKeys: ApiKey[] = Array.isArray(data.apiKeys) ? (data.apiKeys as ApiKey[]) : []
    const githubAccounts: GitHubAccount[] = Array.isArray(data.githubAccounts)
      ? (data.githubAccounts as GitHubAccount[])
      : []
    const usage: UsageRecord[] = Array.isArray(data.usage) ? (data.usage as UsageRecord[]) : []
    const activeId: number | null = typeof data.activeGithubAccountId === "number" ? data.activeGithubAccountId : null

    if (mode === "replace") {
      await Promise.all([repo.apiKeys.deleteAll(), repo.github.deleteAllAccounts(), repo.usage.deleteAll()])
    }

    for (const key of apiKeys) {
      await repo.apiKeys.save(key)
    }

    for (const account of githubAccounts) {
      await repo.github.saveAccount(account.user.id, account)
    }

    for (const record of usage) {
      await repo.usage.set(record)
    }

    if (activeId != null) {
      if (mode === "replace") {
        await repo.github.setActiveId(activeId)
      } else {
        const current = await repo.github.getActiveId()
        if (current == null) {
          await repo.github.setActiveId(activeId)
        }
      }
    }

    return {
      ok: true,
      imported: {
        apiKeys: apiKeys.length,
        githubAccounts: githubAccounts.length,
        usage: usage.length,
      },
    }
  })

  // POST /api/heartbeat - called by LLM Relay clients to report presence
  // Auth: API key (apiKeyId must be set). Registers which client is using which key.
  .post("/heartbeat", async (ctx) => {
    const { body } = ctx
    const { apiKeyId, userId } = ctx as unknown as AuthCtx
    if (!apiKeyId) {
      return new Response(JSON.stringify({ error: "API key required for heartbeat" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    const { clientId, clientName, hostname, gatewayUrl } = body as {
      clientId?: string
      clientName?: string
      hostname?: string
      gatewayUrl?: string
    }
    if (!clientId || !hostname) {
      return new Response(JSON.stringify({ error: "clientId and hostname are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Get real client IP from request
    const ip =
      ctx.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      (ctx.server as any)?.requestIP?.(ctx.request)?.address ??
      null

    // Format display name: "name@hostname (ip)" or "hostname (ip)"
    const ipSuffix = ip ? ` (${ip})` : ""
    const displayName = clientName ? `${clientName}@${hostname}${ipSuffix}` : `${hostname}${ipSuffix}`

    const repo = getRepo()
    const apiKey = await repo.apiKeys.getById(apiKeyId)
    await repo.presence.upsert({
      clientId,
      clientName: displayName,
      keyId: apiKeyId,
      keyName: apiKey?.name ?? null,
      ownerId: userId ?? null,
      gatewayUrl: gatewayUrl ?? null,
      lastSeenAt: new Date().toISOString(),
    })
    return { ok: true }
  })

  // GET /api/relays - list relays with presence info
  // Admin sees all, users see only relays using their own keys
  .get("/relays", async (ctx) => {
    const { isAdmin, userId } = ctx as unknown as AuthCtx
    const repo = getRepo()
    const onlineThresholdMinutes = 3

    let clients
    if (isAdmin) {
      clients = await repo.presence.list()
    } else if (userId) {
      const userKeyIds = await getUserKeyIds(userId)
      clients = await repo.presence.listByKeyIds(userKeyIds)
    } else {
      return []
    }

    const now = Date.now()
    const activeThresholdHours = 2 // check current + previous hour
    const activeHour = new Date(now - activeThresholdHours * 3600 * 1000).toISOString().slice(0, 13)

    // Collect unique keyIds to batch-check active traffic
    const keyIds = [...new Set(clients.map(c => c.keyId).filter(Boolean) as string[])]
    const activeKeyIds = new Set<string>()
    if (keyIds.length > 0) {
      try {
        const usageRows = await repo.usage.query({ keyIds, start: activeHour, end: new Date(now + 3600 * 1000).toISOString().slice(0, 13) })
        for (const r of usageRows) activeKeyIds.add(r.keyId)
      } catch {
        // usage query failure should not break clients endpoint
      }
    }

    // For admin: enrich owner info with readable names
    const ownerNameMap = new Map<string, string>()
    if (isAdmin) {
      const ownerIds = [...new Set(clients.map((c) => c.ownerId).filter(Boolean) as string[])]
      if (ownerIds.length > 0) {
        const users = await Promise.all(ownerIds.map((id) => repo.users.getById(id)))
        for (const u of users) {
          if (u) ownerNameMap.set(u.id, u.name)
        }
      }
    }

    return clients.map((c) => ({
      ...c,
      isOnline: now - new Date(c.lastSeenAt).getTime() < onlineThresholdMinutes * 60 * 1000,
      isActive: c.keyId ? activeKeyIds.has(c.keyId) : false,
      ownerName: c.ownerId ? (ownerNameMap.get(c.ownerId) ?? null) : null,
    }))
  })
