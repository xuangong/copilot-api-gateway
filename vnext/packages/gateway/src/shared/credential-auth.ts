/** Credential resolution shared by HTTP middleware and connection-scoped sessions. */
import { getDataPlaneRepo, getRepo as getRawRepo, hasConfigurationSnapshot } from "../repo/index.ts"
import type { ApiKeyId, SessionToken, UserId } from "../repo/branded-ids.ts"
import { ADMIN_EMAILS, type AccountType } from "./config/constants.ts"
import type { ApiKeyRoutingPolicy } from "./api-key-model-mappings.ts"

const getRepo = () => hasConfigurationSnapshot() ? getDataPlaneRepo() : getRawRepo()

export interface FullAuthCtx {
  userId?: UserId
  isAdmin?: boolean
  isUser?: boolean
  apiKeyId?: ApiKeyId
  responsesRetentionSeconds?: number
  routingPolicy?: ApiKeyRoutingPolicy
  authKind?: "public" | "session" | "apiKey"
  authenticatedAt?: number
  copilot?: { copilotToken: string; accountType: AccountType }
  githubToken?: string
}

export interface ValidatedApiKey {
  id: ApiKeyId
  name: string
  ownerId?: UserId
  responsesRetentionSeconds: number
  routingPolicy: ApiKeyRoutingPolicy
}

export async function validateApiKey(rawKey: string): Promise<ValidatedApiKey | null> {
  const repo = getRepo()
  const key = await repo.apiKeys.findByRawKey(rawKey)
  if (!key) return null
  const routingPolicy: ApiKeyRoutingPolicy = key.modelMappingsInvalid
    ? { modelMappingsEnabled: false, modelMappings: [] }
    : {
        modelMappingsEnabled: key.modelMappingsEnabled,
        modelMappings: key.modelMappings.map((mapping) => ({ ...mapping })),
      }
  return { id: key.id, name: key.name, ownerId: key.ownerId, routingPolicy, responsesRetentionSeconds: key.responsesRetentionSeconds ?? 0 }
}

/** Resolve a credential without transport extraction or optional Copilot prewarm. */
export async function resolveCredential(key: string, options: { requireEnabledOwner?: boolean } = {}): Promise<FullAuthCtx | undefined> {
  let ctx: FullAuthCtx | undefined
  if (key.startsWith("ses_")) {
    const repo = getRepo()
    const session = await repo.sessions.findByToken(key as SessionToken)
    if (session && new Date(session.expiresAt) > new Date()) {
      const user = await repo.users.getById(session.userId)
      if (user && !user.disabled) {
        const isAdmin = !!(user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()))
        ctx = {
          userId: session.userId,
          isAdmin,
          isUser: true,
          authKind: "session",
          authenticatedAt: session.authenticatedAt,
        }
      }
    }
  } else {
    const result = await validateApiKey(key)
    if (result) {
      ctx = {
        userId: result.ownerId,
        isUser: !!result.ownerId,
        apiKeyId: result.id,
        routingPolicy: result.routingPolicy,
        responsesRetentionSeconds: result.responsesRetentionSeconds,
        authKind: "apiKey",
      }
    } else {
      // Try User Key (legacy: users.user_key column) for llm-relay / older clients.
      const user = await getRepo().users.findByKey(key)
      if (user && !user.disabled) {
        const isAdmin = !!(user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()))
        ctx = {
          userId: user.id,
          isAdmin,
          isUser: true,
          authKind: "session",
        }
      }
    }
  }
  if (ctx?.userId && options.requireEnabledOwner) {
    const owner = await getRepo().users.getById(ctx.userId)
    if (!owner || owner.disabled) return undefined
  }
  return ctx
}

/** Header precedence shared by WS and HTTP; WS deliberately excludes cookies/query. */
export function extractHeaderCredential(headers: Headers, present: (value: string) => boolean = value => value.length > 0): string | null {
  const apiKey = headers.get("x-api-key")
  if (apiKey && present(apiKey)) return apiKey
  const goog = headers.get("x-goog-api-key")
  if (goog && present(goog)) return goog
  const authorization = headers.get("authorization")
  const bearer = authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7) : undefined
  return bearer && present(bearer) ? bearer : null
}
