// Dashboard API routes - copilot-quota, token-usage, latency, export, import
import { Elysia } from "elysia"
import { getRepo, type ApiKey, type GitHubAccount, type UsageRecord, type LatencyRecord } from "~/repo"
import { getGithubCredentials } from "~/lib/github"
import { createGithubHeaders } from "~/config/constants"

interface AuthCtx {
  isAdmin?: boolean
  isUser?: boolean
  userId?: string
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

/** Get key IDs for the current user (for scoping usage/latency queries) */
async function getUserKeyIds(userId: string): Promise<string[]> {
  const keys = await getRepo().apiKeys.listByOwner(userId)
  return keys.map(k => k.id)
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
      const userKeyIds = await getUserKeyIds(userId)
      queryOpts = { keyIds: userKeyIds, start, end }
      keys = await repo.apiKeys.listByOwner(userId)
    } else {
      queryOpts = { keyId, start, end }
      keys = await repo.apiKeys.list()
    }

    const records = await repo.usage.query(queryOpts)
    const nameMap = new Map(keys.map((k) => [k.id, k.name]))
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
      const userKeyIds = await getUserKeyIds(userId)
      queryOpts = { keyIds: userKeyIds, start, end }
      keys = await repo.apiKeys.listByOwner(userId)
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
