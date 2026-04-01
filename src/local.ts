/**
 * Local development entry point using Bun
 *
 * This file provides a local-compatible environment for debugging
 * without deploying to Cloudflare Workers.
 *
 * Usage: bun run src/local.ts
 */

import { Elysia } from "elysia"
import { cors } from "@elysiajs/cors"
import { mkdir } from "node:fs/promises"

import type { AppState } from "~/lib/state"
import type { AccountType } from "~/config/constants"
import { FileStorage } from "~/storage/file"
import { STORAGE_KEYS } from "~/storage/interface"
import { initRepo } from "~/repo"
import { SqliteRepo, createSqliteDb } from "~/repo/sqlite"
import { getGithubCredentials } from "~/lib/github"
import { getCopilotToken } from "~/services/github"
import { validateApiKey } from "~/lib/api-keys"
import { setLatencyLogCallback } from "~/lib/latency-tracker"
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

// Data directory for local storage
const DATA_DIR = ".data"
const KV_FILE = `${DATA_DIR}/kv.json`
const DB_FILE = `${DATA_DIR}/copilot.db`

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
}

// Status code color
function statusColor(status: number): string {
  if (status >= 500) return colors.red
  if (status >= 400) return colors.yellow
  if (status >= 300) return colors.cyan
  return colors.green
}

// Format duration
function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms"
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

// Latency details for API requests
export interface RequestLatency {
  upstreamMs?: number
  ttfbMs?: number
  tokenMiss?: boolean
  model?: string
  inputTokens?: number
  outputTokens?: number
  stream?: boolean
  userAgent?: string
}

// Global store for request latency (keyed by request id)
const requestLatencyStore = new Map<string, RequestLatency>()
let requestIdCounter = 0

export function setRequestLatency(requestId: string, latency: RequestLatency) {
  requestLatencyStore.set(requestId, latency)
}

// Log request start (for long-running requests)
function logRequestStart(method: string, path: string, model?: string) {
  const timestamp = new Date().toISOString().slice(11, 23)
  const methodPad = method.padEnd(6)
  let line = `${colors.dim}${timestamp}${colors.reset} ${methodPad} ${colors.cyan}...${colors.reset}          ${path}`
  if (model) {
    line += ` ${colors.magenta}${model}${colors.reset}`
  }
  console.log(line)
}

// Log request completion
function logRequest(
  method: string,
  path: string,
  status: number,
  duration: number,
  error?: string,
  latency?: RequestLatency,
) {
  const timestamp = new Date().toISOString().slice(11, 23)
  const sc = statusColor(status)
  const methodPad = method.padEnd(6)
  const durationStr = formatDuration(duration).padStart(8)

  let line = `${colors.dim}${timestamp}${colors.reset} ${methodPad} ${sc}${status}${colors.reset} ${durationStr} ${path}`

  // Add latency details for API requests
  if (latency) {
    const parts: string[] = []
    if (latency.model) {
      parts.push(`${colors.magenta}${latency.model}${colors.reset}`)
    }
    if (latency.stream !== undefined) {
      parts.push(latency.stream ? `${colors.cyan}stream${colors.reset}` : "sync")
    }
    if (latency.inputTokens !== undefined) {
      parts.push(`${colors.dim}in=${latency.inputTokens}${colors.reset}`)
    }
    if (latency.outputTokens !== undefined) {
      parts.push(`${colors.dim}out=${latency.outputTokens}${colors.reset}`)
    }
    if (latency.upstreamMs !== undefined) {
      parts.push(`${colors.blue}upstream=${formatDuration(latency.upstreamMs)}${colors.reset}`)
    }
    if (latency.ttfbMs !== undefined && latency.ttfbMs !== latency.upstreamMs) {
      parts.push(`${colors.cyan}ttfb=${formatDuration(latency.ttfbMs)}${colors.reset}`)
    }
    if (latency.tokenMiss) {
      parts.push(`${colors.yellow}token-miss${colors.reset}`)
    }
    // Show user agent for non-streaming requests (helps debug why not streaming)
    if (latency.stream === false && latency.userAgent) {
      // Extract short client name from user-agent
      const ua = latency.userAgent
      let client = "unknown"
      if (ua.includes("curl")) client = "curl"
      else if (ua.includes("Python")) client = "python"
      else if (ua.includes("node")) client = "node"
      else if (ua.includes("Claude")) client = "claude"
      else if (ua.includes("Anthropic")) client = "anthropic-sdk"
      else if (ua.includes("OpenAI")) client = "openai-sdk"
      else client = ua.slice(0, 20)
      parts.push(`${colors.dim}client=${client}${colors.reset}`)
    }
    if (parts.length > 0) {
      line += ` [${parts.join(" ")}]`
    }
  }

  if (error) {
    line += ` ${colors.red}← ${error}${colors.reset}`
  }

  console.log(line)
}

// Environment from process.env (Bun auto-loads .env)
interface LocalEnv {
  ACCOUNT_TYPE?: string
  ADMIN_KEY: string
  LANGSEARCH_API_KEY?: string
  TAVILY_API_KEY?: string
  PORT?: string
}

const env: LocalEnv = {
  ACCOUNT_TYPE: process.env.ACCOUNT_TYPE,
  ADMIN_KEY: process.env.ADMIN_KEY || "xuangong123!",
  LANGSEARCH_API_KEY: process.env.LANGSEARCH_API_KEY,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  PORT: process.env.PORT,
}

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

// In-process copilot token cache
const IN_PROCESS_TTL_MS = 10 * 60_000 // 10 minutes
let memCopilotToken: string | null = null
let memCopilotExpires = 0
let memCachedAt = 0

async function loadState(storage: FileStorage): Promise<AppState> {
  // Get GitHub token from database (via /auth/github device flow)
  let githubToken: string | null = null
  let accountType: AccountType = "individual"

  try {
    const creds = await getGithubCredentials()
    githubToken = creds.token
    accountType = creds.accountType as AccountType
  } catch {
    // Fall back to file storage cache
    githubToken = await storage.get(STORAGE_KEYS.GITHUB_TOKEN)
    accountType = (env.ACCOUNT_TYPE as AccountType) || "individual"
  }

  if (!githubToken) {
    throw new Error(
      "GitHub token not found. Use /auth/github to connect your account.",
    )
  }

  const now = Date.now() / 1000
  let tokenMiss = false

  // Level 1: in-process memory cache (0ms, same process)
  let copilotToken = memCopilotToken
  let copilotTokenExpires = memCopilotExpires
  const memFresh = Date.now() - memCachedAt < IN_PROCESS_TTL_MS

  if (!copilotToken || copilotTokenExpires < now + 60 || !memFresh) {
    // Level 2: file cache
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

async function createApp() {
  // Ensure data directory exists
  await mkdir(DATA_DIR, { recursive: true })

  // Initialize file storage
  const storage = new FileStorage(KV_FILE)
  await storage.init()

  // Initialize SQLite repo
  const db = createSqliteDb(DB_FILE)
  const repo = new SqliteRepo(db)
  initRepo(repo)

  // Set up latency logging callback for local mode
  setLatencyLogCallback((requestId, model, info) => {
    setRequestLatency(requestId, {
      model,
      upstreamMs: info.upstreamMs,
      ttfbMs: info.ttfbMs,
      tokenMiss: info.tokenMiss,
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
      stream: info.stream,
      userAgent: info.userAgent,
    })
  })

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
    // Request logging - store start time and generate request id
    .derive(({ request }) => {
      const requestId = String(++requestIdCounter)
      const userAgent = request.headers.get("user-agent") || ""
      return { requestStart: performance.now(), requestPath: new URL(request.url).pathname, requestId, userAgent }
    })
    // After response logging
    .onAfterResponse(({ request, requestStart, requestPath, requestId, set }) => {
      const duration = performance.now() - requestStart
      const status = typeof set.status === "number" ? set.status : 200
      const latency = requestLatencyStore.get(requestId)
      requestLatencyStore.delete(requestId) // cleanup
      logRequest(request.method, requestPath, status, duration, undefined, latency)
    })
    // Global error handler - simple error format for frontend
    .onError(({ error, set, request, requestStart, requestPath, requestId }) => {
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
      // Log error
      const duration = performance.now() - (requestStart ?? 0)
      const path = requestPath ?? new URL(request.url).pathname
      const latency = requestId ? requestLatencyStore.get(requestId) : undefined
      if (requestId) requestLatencyStore.delete(requestId)
      logRequest(request.method, path, Number(set.status), duration, message, latency)
      return { error: message }
    })
    // Health check and UI routes - no auth required
    .get("/", ({ headers }) => {
      const accept = headers.accept ?? ""
      if (accept.includes("application/json") && !accept.includes("text/html")) {
        return { status: "ok", service: "copilot-api-gateway", mode: "local" }
      }
      return new Response(LoginPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } })
    })
    .head("/", () => new Response(null, { status: 200 }))
    .get("/dashboard", () => new Response(DashboardPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .head("/dashboard", () => new Response(null, { status: 200 }))
    .get("/health", () => ({ status: "healthy", mode: "local" }))
    .head("/health", () => new Response(null, { status: 200 }))
    .get("/favicon.ico", () => new Response(null, { status: 204 }))
    // Derive env and auth context for all routes
    .derive(async ({ request, path, requestId, userAgent }) => {
      const auth = await authCheck(request, path)
      // Return env-like object for compatibility with Workers code
      return {
        env: {
          KV: storage, // FileStorage implements IStorage, same interface
          DB: db, // SQLite database
          ...env,
        },
        ...auth,
        requestId, // pass through for latency logging
        userAgent, // pass through for logging
      }
    })
    // Auth routes (don't need Copilot token)
    .use(authRoute)
    .use(apiKeysRoute)
    .use(dashboardRoute)
    // API routes with Copilot token - only load state for API paths
    .derive(async ({ path }) => {
      // Local mode: colo is always "local"
      const colo = "local"

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
          const state = await loadState(storage)
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
    // Log API request start for long-running requests
    .onBeforeHandle(({ request, requestPath }) => {
      if (requestPath.startsWith("/v1/") || requestPath.startsWith("/chat/") || requestPath.startsWith("/v1beta/")) {
        // Try to extract model from request body (best effort)
        const contentType = request.headers.get("content-type") || ""
        if (contentType.includes("json")) {
          // Clone and peek at body - we can't actually read it here without blocking
          // Just log that request started
          logRequestStart(request.method, requestPath)
        }
      }
    })
    .use(chatCompletionsRoute)
    .use(messagesRoute)
    .use(responsesRoute)
    .use(geminiRoute)
}

// Start server
const port = Number(env.PORT) || 41414

createApp().then((app) => {
  app.listen(port)
  console.log(`🚀 Copilot API Gateway (local mode) running at http://localhost:${port}`)
  console.log(`📁 Data directory: ${DATA_DIR}`)
  console.log(`📦 Database: ${DB_FILE}`)
  console.log(`💾 KV Storage: ${KV_FILE}`)
  console.log(`🔑 Admin key: ${env.ADMIN_KEY}`)
})
