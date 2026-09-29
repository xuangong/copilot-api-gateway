import type { UpstreamRecord } from "../../repo/types.ts"
import { BILLING_DIMENSIONS } from "@vibe-llm/protocols/common"
import { parseCustomChatMetadata } from "@vibe-llm/provider-custom"
import { substrateTokenExpiry } from "@vibe-llm/provider-sdf"

export type PublicUpstream = Pick<UpstreamRecord<unknown>,
  "id" | "ownerId" | "provider" | "name" | "enabled" | "sortOrder" | "config" |
  "flagOverrides" | "disabledPublicModelIds" | "proxyFallbackList" | "createdAt" | "updatedAt"> & {
    tokenExpiredAt?: string
    credentialStatus?: PublicCodexCredentialStatus
  }

export interface PublicCodexCredentialStatus {
  health: "active" | "access_rejected" | "session_terminated" | "refresh_failed" | "credential_expired"
  renewable: boolean
  expiresAt: number | null
  expiryKnown: boolean
  quotaObservedAt: number | null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function scalars(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = record(value)
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const entry = source[key]
    if (entry === null || typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) out[key] = entry
  }
  return out
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined
}

function secret(out: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(source, key)) out[key] = source[key] ? "***" : source[key] === null ? null : ""
}

function publicModels(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(entry => {
    if (typeof entry === "string") return entry
    const source = record(entry)
    const out = scalars(source, ["id", "name", "ownedBy", "upstreamModelId"])
    if (source.cost) out.cost = Object.fromEntries(Object.entries(scalars(source.cost, BILLING_DIMENSIONS)).filter(([, cost]) => typeof cost === "number"))
    if (source.chat) {
      try { out.chat = parseCustomChatMetadata(source.chat) } catch { /* Invalid stored metadata grants no public fields. */ }
    }
    return out
  })
}

function publicCodexCredentialStatus(value: unknown): PublicCodexCredentialStatus | undefined {
  const accounts = record(value).accounts
  if (!Array.isArray(accounts) || accounts.length !== 1) return undefined
  const account = record(accounts[0])
  const accessToken = record(account.accessToken)
  const rawExpiry = accessToken.expiresAt
  const expiresAt = typeof rawExpiry === "number" && Number.isFinite(rawExpiry) ? rawExpiry : null
  const renewable = typeof account.refresh_token === "string" && account.refresh_token.length > 0
  const state = account.state
  const health = state === "access_rejected" || state === "session_terminated" || state === "refresh_failed"
    ? state
    : !renewable && (typeof accessToken.token !== "string" || (expiresAt !== null && expiresAt <= Date.now()))
      ? "credential_expired" : "active"
  const quota = record(account.quotaSnapshot)
  const observations = Object.values(quota).map(entry => record(entry).fetchedAt)
    .filter((time): time is number => typeof time === "number" && Number.isFinite(time))
  return {
    health, renewable, expiresAt, expiryKnown: expiresAt !== null,
    quotaObservedAt: observations.length ? Math.max(...observations) : null,
  }
}

export function publicUpstreamConfig(upstream: UpstreamRecord<unknown>): Record<string, unknown> {
  const source = record(upstream.config)
  let out: Record<string, unknown>
  switch (upstream.provider) {
    case "copilot":
      out = scalars(source, ["accountType", "githubHost", "source"])
      secret(out, source, "githubToken")
      if (source.user) out.user = scalars(source.user, ["id", "login", "name", "avatar_url"])
      return out
    case "codex":
    case "claude-code": {
      const keys = upstream.provider === "codex"
        ? ["email", "chatgptAccountId", "chatgptUserId", "planType"]
        : ["email", "accountUuid", "organizationUuid", "subscriptionType", "rateLimitTier"]
      return Array.isArray(source.accounts) ? { accounts: source.accounts.map(account => scalars(account, keys)) } : {}
    }
    case "sdf":
      out = scalars(source, ["name"])
      secret(out, source, "substrateToken")
      if (source.taxonomy) out.taxonomy = scalars(source.taxonomy, ["experience", "agent", "inferenceStep", "trafficType"])
      if (source.cos) out.cos = scalars(source.cos, ["serviceTier"])
      if (source.passport) out.passport = scalars(source.passport, ["enabled", "apiBase"])
      return out
    case "azure":
      out = scalars(source, ["name", "endpoint", "deployment", "apiVersion"])
      if (Array.isArray(source.deployments)) out.deployments = source.deployments.map(entry => scalars(entry, ["name", "model"]))
      break
    case "custom":
      out = scalars(source, ["name", "baseUrl", "authStyle", "modelsEndpoint"])
      if (source.pathOverrides) out.pathOverrides = scalars(source.pathOverrides, ["chat_completions", "responses", "messages", "embeddings", "images_generations", "images_edits", "alpha_search"])
      if (source.models) out.models = publicModels(source.models)
      break
    default:
      return {}
  }
  secret(out, source, "apiKey")
  if (source.endpoints) out.endpoints = strings(source.endpoints)
  if (source.defaultHeaders) out.defaultHeaders = Object.fromEntries(Object.keys(record(source.defaultHeaders)).map(key => [key, "***"]))
  return out
}

export function serializeUpstream(upstream: UpstreamRecord<unknown>): PublicUpstream {
  const dto: PublicUpstream = {
    id: upstream.id, ownerId: upstream.ownerId, provider: upstream.provider, name: upstream.name,
    enabled: upstream.enabled, sortOrder: upstream.sortOrder, config: publicUpstreamConfig(upstream),
    flagOverrides: upstream.flagOverrides, disabledPublicModelIds: upstream.disabledPublicModelIds,
    proxyFallbackList: upstream.proxyFallbackList, createdAt: upstream.createdAt, updatedAt: upstream.updatedAt,
  }
  if (upstream.provider === "sdf") {
    const token = record(upstream.config).substrateToken
    const exp = typeof token === "string" ? substrateTokenExpiry(token) : null
    if (exp !== null && exp * 1000 <= Date.now()) dto.tokenExpiredAt = new Date(exp * 1000).toISOString()
  }
  if (upstream.provider === "codex") dto.credentialStatus = publicCodexCredentialStatus(upstream.state)
  return dto
}
