import { Elysia } from "elysia"

import {
  listGithubAccounts,
  listGithubAccountsForUser,
  addGithubAccount,
  removeGithubAccount,
  setActiveGithubAccount,
  type GitHubUser,
} from "~/lib/github"
import { GITHUB_CLIENT_ID } from "~/config/constants"

import { type AuthContext, GITHUB_SCOPES, detectAccountType } from "./utils"

export const githubRoute = new Elysia()
  // GET /auth/github - start GitHub Device Flow
  .get("/github", async () => {
    const resp = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: GITHUB_SCOPES,
      }),
    })

    if (!resp.ok) {
      const text = await resp.text()
      return new Response(JSON.stringify({ error: `GitHub error: ${text}` }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    }

    return resp.json()
  })

  // POST /auth/github/poll - poll for device flow completion
  .post("/github/poll", async (ctx) => {
    const { body } = ctx
    const { userId } = ctx as unknown as AuthContext
    const { device_code } = body as { device_code: string }

    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    const data = (await resp.json()) as {
      access_token?: string
      error?: string
      error_description?: string
      interval?: number
    }

    if (data.error === "authorization_pending") {
      return { status: "pending" }
    }

    if (data.error === "slow_down") {
      return { status: "slow_down", interval: data.interval }
    }

    if (data.error) {
      return new Response(
        JSON.stringify({ status: "error", error: data.error_description ?? data.error }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    if (data.access_token) {
      const userResp = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `token ${data.access_token}`,
          accept: "application/json",
          "user-agent": "copilot-api-gateway",
        },
      })

      if (!userResp.ok) {
        return new Response(
          JSON.stringify({ status: "error", error: "Failed to fetch GitHub user info" }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        )
      }

      const user = (await userResp.json()) as GitHubUser

      const accountType = await detectAccountType(data.access_token)
      await addGithubAccount(data.access_token, user, accountType, userId)

      return { status: "complete", user }
    }

    return new Response(JSON.stringify({ status: "error", error: "Unknown response" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  })

  // GET /auth/me - identity-only. Always uses the caller's session userId
  // (does NOT honor `?as_user=...`). The upstream-accounts list now lives at
  // /api/upstream-accounts.
  .get("/me", async (ctx) => {
    const { isAdmin, userId } = ctx as unknown as AuthContext

    // Cheap connectivity check: do any GitHub accounts exist for this caller?
    // Avoids the per-account fanout (token validity + Copilot quota) that the
    // old /auth/me did synchronously on every dashboard load.
    let githubConnected = false
    if (isAdmin) {
      const all = await listGithubAccounts()
      githubConnected = all.length > 0
    } else if (userId) {
      const own = await listGithubAccountsForUser(userId)
      githubConnected = own.length > 0
    }

    return {
      authenticated: true,
      github_connected: githubConnected,
      accounts: [],
    }
  })

  // DELETE /auth/github/:id - disconnect a specific GitHub account
  .delete("/github/:id", async (ctx) => {
    const { params } = ctx
    const { isAdmin, userId } = ctx as unknown as AuthContext
    const ghUserId = Number(params.id)
    if (!ghUserId || isNaN(ghUserId)) {
      return new Response(JSON.stringify({ error: "Invalid user ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    await removeGithubAccount(ghUserId, isAdmin ? undefined : userId)
    return { ok: true }
  })

  // POST /auth/github/switch - switch active GitHub account
  .post("/github/switch", async (ctx) => {
    const { body } = ctx
    const { userId } = ctx as unknown as AuthContext
    const { user_id } = body as { user_id: number }
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    const ok = await setActiveGithubAccount(user_id, userId)
    if (!ok) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }
    return { ok: true }
  })
