import { Elysia } from "elysia"
import {
  listGithubAccounts,
  addGithubAccount,
  removeGithubAccount,
  setActiveGithubAccount,
  getActiveGithubAccount,
  type GitHubUser,
} from "~/lib/github"
import { validateApiKey } from "~/lib/api-keys"
import { GITHUB_CLIENT_ID, createGithubHeaders } from "~/config/constants"
import type { Env } from "~/lib/state"

const GITHUB_SCOPES = "read:user"

async function detectAccountType(githubToken: string): Promise<string> {
  try {
    const resp = await fetch("https://api.github.com/copilot_internal/user", {
      headers: createGithubHeaders(githubToken),
    })
    if (!resp.ok) return "individual"
    const data = (await resp.json()) as { copilot_plan?: string }
    if (data.copilot_plan && ["individual", "business", "enterprise"].includes(data.copilot_plan)) {
      return data.copilot_plan
    }
    return "individual"
  } catch {
    return "individual"
  }
}

// Context type that includes env from derive
interface AuthContext {
  env: Env
}

export const authRoute = new Elysia({ prefix: "/auth" })
  // POST /auth/login - validate ADMIN_KEY or API key
  .post("/login", async (ctx) => {
    const { body } = ctx
    const env = (ctx as unknown as AuthContext).env
    const { key } = body as { key: string }
    const adminKey = env?.ADMIN_KEY

    if (adminKey && key === adminKey) {
      return { ok: true, isAdmin: true }
    }

    const result = await validateApiKey(key)
    if (result) {
      return {
        ok: true,
        isAdmin: false,
        keyId: result.id,
        keyName: result.name,
        keyHint: key.slice(-4),
      }
    }

    return new Response(JSON.stringify({ error: "Invalid key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  })

  // POST /auth/logout - no-op
  .post("/logout", () => ({ ok: true }))

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
  .post("/github/poll", async ({ body }) => {
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
      // Fetch user info
      const userResp = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `token ${data.access_token}`,
          accept: "application/json",
          "user-agent": "copilot-api-gateway",
        },
      })

      let user: GitHubUser = {
        login: "unknown",
        avatar_url: "",
        name: null,
        id: 0,
      }
      if (userResp.ok) {
        user = (await userResp.json()) as GitHubUser
      }

      // Store account and set as active
      const accountType = await detectAccountType(data.access_token)
      await addGithubAccount(data.access_token, user, accountType)

      return { status: "complete", user }
    }

    return new Response(JSON.stringify({ status: "error", error: "Unknown response" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  })

  // GET /auth/me - get all GitHub accounts + active account info
  .get("/me", async () => {
    const accounts = await listGithubAccounts()
    const active = await getActiveGithubAccount()

    // If we have an active account but no user info cached, try to fetch it
    if (active && !active.user.login) {
      try {
        const userResp = await fetch("https://api.github.com/user", {
          headers: {
            authorization: `token ${active.token}`,
            accept: "application/json",
            "user-agent": "copilot-api-gateway",
          },
        })
        if (userResp.ok) {
          const user = (await userResp.json()) as GitHubUser
          await addGithubAccount(active.token, user, active.accountType)
        }
      } catch {
        // Ignore
      }
    }

    // Check token validity for each account in parallel
    const healthChecks = await Promise.allSettled(
      accounts.map(async (a) => {
        try {
          const resp = await fetch("https://api.github.com/user", {
            headers: {
              authorization: `token ${a.token}`,
              accept: "application/json",
              "user-agent": "copilot-api-gateway",
            },
          })
          return resp.ok
        } catch {
          return false
        }
      }),
    )

    return {
      authenticated: true,
      github_connected: accounts.length > 0,
      accounts: accounts.map((a, i) => ({
        id: a.user.id,
        login: a.user.login,
        name: a.user.name,
        avatar_url: a.user.avatar_url,
        account_type: a.accountType,
        active: active?.user.id === a.user.id,
        token_valid: (() => { const r = healthChecks[i]; return r && r.status === "fulfilled" && r.value })(),
      })),
    }
  })

  // DELETE /auth/github/:id - disconnect a specific GitHub account
  .delete("/github/:id", async ({ params }) => {
    const userId = Number(params.id)
    if (!userId || isNaN(userId)) {
      return new Response(JSON.stringify({ error: "Invalid user ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    await removeGithubAccount(userId)
    return { ok: true }
  })

  // POST /auth/github/switch - switch active GitHub account
  .post("/github/switch", async ({ body }) => {
    const { user_id } = body as { user_id: number }
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    const ok = await setActiveGithubAccount(user_id)
    if (!ok) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }
    return { ok: true }
  })
