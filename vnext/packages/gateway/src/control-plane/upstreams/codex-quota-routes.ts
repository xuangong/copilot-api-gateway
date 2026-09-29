import { Hono } from "hono"
import { readCodexQuotaObservations } from "@vibe-llm/provider-codex"
import type { Env } from "../../app.ts"
import { getRepo } from "../../repo/index.ts"
import type { UpstreamId, UserId } from "../../repo/branded-ids.ts"
import { loadOwned } from "../shared/ownership.ts"

type Vars = { auth: { authKind?: "public" | "session" | "apiKey"; userId?: UserId; isAdmin?: boolean } }
export const codexQuotaRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

codexQuotaRouter.get("/:id/codex/quota", async c => {
  c.header("Cache-Control", "no-store")
  const auth = c.get("auth")
  if (auth?.authKind !== "session" || !auth.userId) return c.json({ error: "Forbidden" }, 403)
  try {
    const row = await loadOwned(auth, () => getRepo().upstreams.getById(c.req.param("id") as UpstreamId))
    if (!row || row.provider !== "codex") return c.json({ error: "upstream not found" }, 404)
    const accounts: unknown = row.config.accounts
    if (!Array.isArray(accounts) || accounts.length !== 1) return c.json({ error: "Quota account unavailable" }, 409)
    const account: unknown = accounts[0]
    if (typeof account !== "object" || account === null || !("chatgptAccountId" in account) ||
      typeof account.chatgptAccountId !== "string" || !account.chatgptAccountId) {
      return c.json({ error: "Quota account unavailable" }, 409)
    }
    return c.json({ quota: readCodexQuotaObservations(row.state, account.chatgptAccountId) })
  } catch {
    return c.json({ error: "Failed to read quota observation" }, 500)
  }
})
