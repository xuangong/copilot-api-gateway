import { Elysia } from "elysia"
import { cors } from "@elysiajs/cors"

import type { Env, AppState } from "~/lib/state"
import type { AccountType } from "~/config/constants"
import { KVStorage, STORAGE_KEYS } from "~/storage"
import { initRepo, D1Repo } from "~/repo"
import { getGithubCredentials } from "~/lib/github"
import { getCopilotToken } from "~/services/github"
import { validateApiKey } from "~/lib/api-keys"
import { messagesRoute } from "~/routes/messages"
import { responsesRoute } from "~/routes/responses"
import { chatCompletionsRoute } from "~/routes/chat-completions"
import { modelsRoute } from "~/routes/models"
import { geminiRoute } from "~/routes/gemini"
import { authRoute } from "~/routes/auth"
import { apiKeysRoute } from "~/routes/api-keys"
import { dashboardRoute } from "~/routes/dashboard"
import { LoginPage } from "~/ui/login"
import { DashboardPage } from "~/ui/dashboard"

// Public paths that don't require authentication
const PUBLIC_GET_PATHS = new Set(["/", "/dashboard", "/favicon.ico", "/health"])
const AUTH_VALIDATE_PATHS = new Set(["/auth/login"])

// Dashboard routes - ADMIN_KEY can access these
const DASHBOARD_PREFIXES = ["/api/", "/auth/"]

function extractKey(request: Request): string | null {
  const url = new URL(request.url)
  const fromQuery = url.searchParams.get("key")
  if (fromQuery) return fromQuery

  const apiKey = request.headers.get("x-api-key")
  if (apiKey) return apiKey

  const auth = request.headers.get("authorization")
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7)
  }

  return null
}

// In-process copilot token cache — avoids KV reads on every request within the same isolate.
// CF Worker isolates can handle many requests before being recycled, so this saves ~50-200ms per hit.
const IN_PROCESS_TTL_MS = 10 * 60_000 // 10 minutes
let memCopilotToken: string | null = null
let memCopilotExpires = 0
let memCachedAt = 0

async function loadState(env: Env, storage: KVStorage): Promise<AppState> {
  // Try to get GitHub token from D1 (multi-account) first, then fall back to env/KV
  let githubToken: string | null = null
  let accountType: AccountType = "individual"

  try {
    const creds = await getGithubCredentials()
    githubToken = creds.token
    accountType = creds.accountType as AccountType
  } catch {
    // Fall back to env/KV
    githubToken = env.GITHUB_TOKEN || (await storage.get(STORAGE_KEYS.GITHUB_TOKEN))
    accountType = (env.ACCOUNT_TYPE as AccountType) || "individual"
  }

  if (!githubToken) {
    throw new Error(
      "GitHub token not found. Use /auth/github to connect your account.",
    )
  }

  const now = Date.now() / 1000
  let tokenMiss = false

  // Level 1: in-process memory cache (0ms, same isolate)
  let copilotToken = memCopilotToken
  let copilotTokenExpires = memCopilotExpires
  const memFresh = Date.now() - memCachedAt < IN_PROCESS_TTL_MS

  if (!copilotToken || copilotTokenExpires < now + 60 || !memFresh) {
    // Level 2: KV cache (cross-datacenter, survives isolate restarts)
    copilotToken = await storage.get(STORAGE_KEYS.COPILOT_TOKEN)
    copilotTokenExpires = Number(
      (await storage.get(STORAGE_KEYS.COPILOT_TOKEN_EXPIRES)) || 0,
    )

    if (!copilotToken || copilotTokenExpires < now + 60) {
      // Level 3: fetch from GitHub API
      tokenMiss = true
      const tokenResponse = await getCopilotToken(githubToken)
      copilotToken = tokenResponse.token
      copilotTokenExpires = tokenResponse.expires_at

      const ttl = Math.max(tokenResponse.refresh_in - 60, 60)
      await storage.set(STORAGE_KEYS.COPILOT_TOKEN, copilotToken, {
        expirationTtl: ttl,
      })
      await storage.set(
        STORAGE_KEYS.COPILOT_TOKEN_EXPIRES,
        String(copilotTokenExpires),
        { expirationTtl: ttl },
      )
    }

    // Update in-process cache
    memCopilotToken = copilotToken
    memCopilotExpires = copilotTokenExpires
    memCachedAt = Date.now()
  }

  return {
    githubToken,
    copilotToken,
    copilotTokenExpires,
    accountType,
    tokenMiss,
    langsearchKey: env.LANGSEARCH_API_KEY,
    tavilyKey: env.TAVILY_API_KEY,
  }
}

function createApp(env: Env) {
  const storage = new KVStorage(env.KV)

  // Initialize D1 repo if available
  if (env.DB) {
    initRepo(new D1Repo(env.DB))
  }

  // Auth middleware function
  const authCheck = async (request: Request, path: string) => {
    const method = request.method

    // Public paths - no auth needed
    if (PUBLIC_GET_PATHS.has(path) && method === "GET") {
      return { authKey: "", isAdmin: false, apiKeyId: undefined }
    }

    // Auth validation path - no auth needed
    if (AUTH_VALIDATE_PATHS.has(path) && method === "POST") {
      return { authKey: "", isAdmin: false, apiKeyId: undefined }
    }

    // Auth routes before GitHub connected don't need a key
    if (path.startsWith("/auth/")) {
      const key = extractKey(request)
      if (!key) {
        return { authKey: "", isAdmin: false, apiKeyId: undefined }
      }
      // With a key, check if it's valid
      const adminKey = env.ADMIN_KEY
      if (adminKey && key === adminKey) {
        return { authKey: key, isAdmin: true, apiKeyId: undefined }
      }
      const result = await validateApiKey(key)
      if (result) {
        return { authKey: key, isAdmin: false, apiKeyId: result.id }
      }
      // Invalid key but on auth route - allow anyway (will be handled by route)
      return { authKey: "", isAdmin: false, apiKeyId: undefined }
    }

    const key = extractKey(request)
    if (!key) {
      throw new Error("Unauthorized")
    }

    // Check ADMIN_KEY - dashboard/management only
    const adminKey = env.ADMIN_KEY
    if (adminKey && key === adminKey) {
      // Admin key can only access dashboard routes
      if (DASHBOARD_PREFIXES.some((p) => path.startsWith(p))) {
        return { authKey: key, isAdmin: true, apiKeyId: undefined }
      }
      throw new Error("This key is for dashboard only. Create an API key for API access.")
    }

    // Check API key - full access
    const result = await validateApiKey(key)
    if (result) {
      return { authKey: key, isAdmin: false, apiKeyId: result.id }
    }

    throw new Error("Unauthorized")
  }

  return new Elysia({ aot: false })
    .use(cors())
    // Global error handler - simple error format for frontend
    .onError(({ error, set }) => {
      const err = error instanceof Error ? error : new Error(String(error))
      const message = err.message
      // Set appropriate status code
      if (message === "Unauthorized") {
        set.status = 401
      } else if (message.includes("dashboard only")) {
        set.status = 403
      } else if (!set.status || Number(set.status) < 400) {
        set.status = 500
      }
      return { error: message }
    })
    // Health check and UI routes - no auth required
    .get("/", ({ headers }) => {
      const accept = headers.accept ?? ""
      if (accept.includes("application/json") && !accept.includes("text/html")) {
        return { status: "ok", service: "copilot-api-gateway" }
      }
      return new Response(LoginPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } })
    })
    .head("/", () => new Response(null, { status: 200 }))
    .get("/dashboard", () => new Response(DashboardPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .head("/dashboard", () => new Response(null, { status: 200 }))
    .get("/health", () => ({ status: "healthy" }))
    .head("/health", () => new Response(null, { status: 200 }))
    .get("/favicon.ico", () => new Response(null, { status: 204 }))
    // Derive env and auth context for all routes
    .derive(async ({ request, path }) => {
      const auth = await authCheck(request, path)
      return { env, ...auth }
    })
    // Auth routes (don't need Copilot token)
    .use(authRoute)
    .use(apiKeysRoute)
    .use(dashboardRoute)
    // API routes with Copilot token - only load state for API paths
    .derive(async ({ path, request }) => {
      // Extract CF data center from request (Cloudflare Workers)
      const colo = (request as unknown as { cf?: { colo?: string } }).cf?.colo ?? "unknown"

      // Only load Copilot state for actual API routes
      if (
        path.startsWith("/v1/") ||
        path.startsWith("/chat/") ||
        path.startsWith("/responses") ||
        path.startsWith("/models") ||
        path === "/api/models" ||
        path.startsWith("/embeddings") ||
        path.startsWith("/v1beta/")
      ) {
        try {
          const state = await loadState(env, storage)
          return { storage, state, colo }
        } catch {
          // Allow /api/models to work without GitHub connection
          if (path === "/api/models") {
            return { storage, state: null as AppState | null, colo }
          }
          throw new Error("GitHub token not found. Use /auth/github to connect your account.")
        }
      }
      return { storage, state: null as AppState | null, colo }
    })
    .use(modelsRoute)
    .use(chatCompletionsRoute)
    .use(messagesRoute)
    .use(responsesRoute)
    .use(geminiRoute)
}

// Cloudflare Workers export
export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const app = createApp(env)
    return app.handle(request)
  },
}
