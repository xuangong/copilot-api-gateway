// Dashboard API routes - copilot-quota, token-usage, latency, export, import
import { Elysia } from "elysia"
import { getRepo, type ApiKey, type GitHubAccount, type UsageRecord, type LatencyRecord } from "~/repo"
import { getGithubCredentials } from "~/lib/github"
import { createGithubHeaders } from "~/config/constants"

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

export const dashboardRoute = new Elysia({ prefix: "/api" })
  // GET /api/copilot-quota - fetch Copilot usage/quota info from GitHub API
  .get("/copilot-quota", async () => {
    try {
      const { token: githubToken } = await getGithubCredentials()
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
  .get("/token-usage", async ({ query }) => {
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
    const [records, keys] = await Promise.all([repo.usage.query({ keyId, start, end }), repo.apiKeys.list()])

    const nameMap = new Map(keys.map((k) => [k.id, k.name]))
    return records.map((r) => ({
      ...r,
      keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
    }))
  })

  // GET /api/latency - query per-key latency records
  .get("/latency", async ({ query }) => {
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
    const [records, keys] = await Promise.all([repo.latency.query({ keyId, start, end }), repo.apiKeys.list()])

    const nameMap = new Map(keys.map((k) => [k.id, k.name]))
    return records.map((r) => ({
      ...r,
      keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
    }))
  })

  // GET /api/export - dump all data as JSON
  .get("/export", async () => {
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

  // POST /api/import - import data with merge or replace mode
  .post("/import", async ({ body }) => {
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

    // Import API keys
    for (const key of apiKeys) {
      await repo.apiKeys.save(key)
    }

    // Import GitHub accounts
    for (const account of githubAccounts) {
      await repo.github.saveAccount(account.user.id, account)
    }

    // Import usage records
    for (const record of usage) {
      await repo.usage.set(record)
    }

    // Set active GitHub account
    if (activeId != null) {
      if (mode === "replace") {
        await repo.github.setActiveId(activeId)
      } else {
        // Merge: only set if currently unset
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
