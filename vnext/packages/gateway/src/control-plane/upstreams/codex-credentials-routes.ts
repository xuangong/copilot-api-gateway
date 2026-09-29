import { Hono } from "hono"
import { getRuntimeLocation } from "@vibe-core/platform"
import { normalizeProxyFallbackList } from "@vibe-core/proxy-repo"
import type { ProxyFallbackEntry } from "@vibe-core/proxy-repo"
import { UpstreamContentionError, UpstreamGoneError, UpstreamReplacedError } from "@vibe-core/upstream-repo"
import { directFetcher } from "@vibe-core/upstream"
import {
  CodexNonrenewableCredentialError, ensureCodexAccessToken, importCodexFromJson,
  mintCodexAccessToken, previewCodexJson, readCodexCredential, readCodexUpstreamState,
} from "@vibe-llm/provider-codex"
import { clearRawModelsCache } from "@vibe-llm/provider-copilot"
import type { Env } from "../../app.ts"
import { getFlagCatalog } from "../../data-plane/flags/index.ts"
import { getRepo } from "../../repo/index.ts"
import type { StoredUpstreamRecord, UpstreamRecord } from "../../repo/types.ts"
import type { UpstreamId, UserId } from "../../repo/branded-ids.ts"
import { getRequestSignal } from "../../shared/request-signal.ts"
import { loadOwned } from "../shared/ownership.ts"
import { serializeUpstream } from "./public-dto.ts"
import { resolveControlPlaneFetcher } from "./proxy-resolution.ts"

interface AuthCtx {
  authKind?: "public" | "session" | "apiKey"
  userId?: UserId
  isAdmin?: boolean
}

type Vars = { auth: AuthCtx }
const MAX_BODY_BYTES = 1024 * 1024
const MAX_IMPORT_ATTEMPTS = 8

class InputError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

const errorResponse = (message: string, status: number): Response => new Response(JSON.stringify({ error: message }), {
  status, headers: { "content-type": "application/json" },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

async function readBoundedBody(request: Request): Promise<Record<string, unknown>> {
  const length = request.headers.get("content-length")
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) {
    throw new InputError("Credential document is too large", 413)
  }
  if (!request.body) throw new InputError("Invalid credential request")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) throw new InputError("Credential document is too large", 413)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  catch { throw new InputError("Invalid credential request") }
  if (!isRecord(parsed)) throw new InputError("Invalid credential request")
  return parsed
}

function credentialDocument(body: Record<string, unknown>): string {
  if (typeof body.document !== "string") throw new InputError("Credential document is required")
  return body.document
}

function selectedSource(body: Record<string, unknown>): number {
  const sourceIndex = body.sourceIndex
  if (!Number.isSafeInteger(sourceIndex) || typeof sourceIndex !== "number" || sourceIndex < 0) {
    throw new InputError("Invalid credential source index")
  }
  return sourceIndex
}

function parserError(error: unknown): Response {
  if (error instanceof Error && /too large/.test(error.message)) return errorResponse("Credential document is too large", 413)
  if (error instanceof Error && /too many accounts/.test(error.message)) return errorResponse("Credential document has too many accounts", 400)
  return errorResponse("Invalid Codex credential document", 400)
}

function safeWriteError(error: unknown): Response {
  if (error instanceof InputError) return errorResponse(error.message, error.status)
  if (error instanceof UpstreamGoneError || error instanceof UpstreamReplacedError) return errorResponse("upstream not found", 404)
  if (error instanceof UpstreamContentionError) return errorResponse("upstream changed; please retry", 409)
  return errorResponse("failed to save upstream", 500)
}

function normalizeFlags(value: unknown): Record<string, boolean> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new InputError("Invalid flag overrides")
  const known = new Set(getFlagCatalog().map(flag => flag.id))
  const flags: Record<string, boolean> = {}
  for (const [key, enabled] of Object.entries(value)) {
    if (!known.has(key) || typeof enabled !== "boolean") throw new InputError("Invalid flag overrides")
    flags[key] = enabled
  }
  return flags
}

function normalizeDisabled(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
    throw new InputError("Invalid disabled model IDs")
  }
  return [...new Set(value.map((entry: string) => entry.trim()).filter(Boolean))]
}

function normalizeProxies(value: unknown): ProxyFallbackEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new InputError("Invalid proxy fallback list")
  const entries: ProxyFallbackEntry[] = value.map(entry => {
    if (!isRecord(entry) || typeof entry.id !== "string" ||
      (entry.colos !== undefined && (!Array.isArray(entry.colos) || entry.colos.some(colo => typeof colo !== "string")))) {
      throw new InputError("Invalid proxy fallback list")
    }
    return { id: entry.id, ...(entry.colos === undefined ? {} : { colos: entry.colos as string[] }) }
  })
  try { return normalizeProxyFallbackList(entries) }
  catch { throw new InputError("Invalid proxy fallback list") }
}

function newUpstream(body: Record<string, unknown>, auth: AuthCtx, imported: Awaited<ReturnType<typeof importCodexFromJson>>): UpstreamRecord<unknown> {
  if (typeof body.name !== "string" || !body.name.trim()) throw new InputError("name required")
  if (body.ownerId !== undefined && typeof body.ownerId !== "string") throw new InputError("Invalid owner ID")
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new InputError("Invalid enabled value")
  if (body.sortOrder !== undefined && (typeof body.sortOrder !== "number" || !Number.isFinite(body.sortOrder))) {
    throw new InputError("Invalid sort order")
  }
  const name = body.name.trim()
  const ownerId = auth.isAdmin && typeof body.ownerId === "string" ? body.ownerId as UserId : auth.userId
  if (ownerId === undefined) throw new InputError("ownerId required")
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "upstream"
  const now = new Date().toISOString()
  const proxyFallbackList = normalizeProxies(body.proxyFallbackList)
  return {
    id: `up_codex_${normalizedName}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}` as UpstreamId,
    ownerId, provider: "codex", name, enabled: body.enabled !== false,
    sortOrder: body.sortOrder as number | undefined ?? 0,
    config: imported.config as unknown as Record<string, unknown>, state: imported.state,
    flagOverrides: normalizeFlags(body.flagOverrides), disabledPublicModelIds: normalizeDisabled(body.disabledPublicModelIds),
    proxyFallbackList, createdAt: now, updatedAt: now,
  }
}

function targetAccount(row: StoredUpstreamRecord): { accountId: string; revision: string | null; deviceId: string; refreshToken: string | null } | null {
  if (row.provider !== "codex") return null
  const identities = row.config.accounts
  if (!Array.isArray(identities) || identities.length !== 1 || !isRecord(identities[0])) return null
  const accountId = identities[0].chatgptAccountId
  if (typeof accountId !== "string" || !accountId) return null
  let state: ReturnType<typeof readCodexUpstreamState>
  try { state = readCodexUpstreamState(row.state) } catch { return null }
  const account = state.accounts[0]
  if (!account || state.accounts.length !== 1 || account.chatgptAccountId !== accountId) return null
  return { accountId, revision: account.credentialRevision ?? null, deviceId: account.openaiDeviceId, refreshToken: account.refresh_token }
}

function sameTarget(row: StoredUpstreamRecord, original: StoredUpstreamRecord, accountId: string, revision: string | null): boolean {
  const current = targetAccount(row)
  return row.id === original.id && row.rowIncarnation === original.rowIncarnation && row.ownerId === original.ownerId &&
    row.provider === "codex" && current?.accountId === accountId && current.revision === revision
}

export const codexCredentialsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

codexCredentialsRouter.post("/codex/preview", async c => {
  if (c.get("auth")?.authKind !== "session" || !c.get("auth")?.userId) return errorResponse("Forbidden", 403)
  let body: Record<string, unknown>
  try { body = await readBoundedBody(c.req.raw) }
  catch (error) { return safeWriteError(error) }
  try { return c.json({ candidates: await previewCodexJson(credentialDocument(body)) }) }
  catch (error) { return error instanceof InputError ? safeWriteError(error) : parserError(error) }
})

codexCredentialsRouter.post("/codex/import", async c => {
  const auth = c.get("auth")
  if (auth?.authKind !== "session" || !auth.userId) return errorResponse("Forbidden", 403)
  let body: Record<string, unknown>
  try { body = await readBoundedBody(c.req.raw) }
  catch (error) { return safeWriteError(error) }
  let imported: Awaited<ReturnType<typeof importCodexFromJson>>
  try {
    const document = credentialDocument(body)
    const sourceIndex = selectedSource(body)
    const selected = (await previewCodexJson(document)).find(row => row.sourceIndex === sourceIndex)
    if (!selected?.importable) throw new InputError("Credential source is unavailable")
    imported = await importCodexFromJson(document, sourceIndex)
  } catch (error) { return error instanceof InputError ? safeWriteError(error) : parserError(error) }

  const hasTarget = body.upstreamId !== undefined
  const allowed = hasTarget
    ? new Set(["document", "sourceIndex", "upstreamId"])
    : new Set(["document", "sourceIndex", "name", "ownerId", "enabled", "sortOrder", "flagOverrides", "disabledPublicModelIds", "proxyFallbackList"])
  if (Object.keys(body).some(key => !allowed.has(key))) return errorResponse("Invalid credential request", 400)
  if (hasTarget) {
    if (typeof body.upstreamId !== "string" || !body.upstreamId) return errorResponse("Invalid upstream ID", 400)
    const id = body.upstreamId as UpstreamId
    const original = await loadOwned(auth, () => getRepo().upstreams.getById(id))
    if (!original) return errorResponse("upstream not found", 404)
    const baseline = targetAccount(original)
    if (!baseline) return errorResponse("Credential target changed", 409)
    if (imported.config.accounts[0].chatgptAccountId !== baseline.accountId) return errorResponse("Credential account cannot be changed", 409)
    for (let attempt = 0; attempt < MAX_IMPORT_ATTEMPTS; attempt++) {
      const current = attempt === 0 ? original : await loadOwned(auth, () => getRepo().upstreams.getById(id))
      if (!current) return errorResponse("upstream not found", 404)
      if (!sameTarget(current, original, baseline.accountId, baseline.revision)) return errorResponse("Credential target changed", 409)
      const replacement = {
        config: imported.config as unknown as Record<string, unknown>,
        state: { accounts: [{ ...imported.state.accounts[0], openaiDeviceId: baseline.deviceId }] },
      }
      try {
        const saved = await getRepo().upstreams.replaceCredentials(current, replacement)
        clearRawModelsCache()
        return c.json({ upstream: serializeUpstream(saved) }, 200)
      } catch (error) {
        if (error instanceof UpstreamContentionError) continue
        return safeWriteError(error)
      }
    }
    return errorResponse("upstream changed; please retry", 409)
  }

  try {
    for (let attempt = 0; attempt < MAX_IMPORT_ATTEMPTS; attempt++) {
      const candidate = newUpstream(body, auth, imported)
      const created = await getRepo().upstreams.createIfAbsent(candidate)
      if (created) {
        clearRawModelsCache()
        return c.json({ upstream: serializeUpstream(created) }, 201)
      }
    }
    return errorResponse("upstream changed; please retry", 409)
  } catch (error) { return safeWriteError(error) }
})

codexCredentialsRouter.post("/:id/credentials/refresh", async c => {
  const auth = c.get("auth")
  if (auth?.authKind !== "session" || !auth.userId) return errorResponse("Forbidden", 403)
  const id = c.req.param("id") as UpstreamId
  const row = await loadOwned(auth, () => getRepo().upstreams.getById(id))
  if (!row) return errorResponse("upstream not found", 404)
  const account = targetAccount(row)
  if (!account) return errorResponse("Credential target changed", 409)
  if (account.refreshToken === null) return errorResponse("Codex credential cannot be refreshed", 409)
  const request = c.req.raw.signal
  const lifetime = getRequestSignal()
  const signal = lifetime && lifetime !== request ? AbortSignal.any([lifetime, request]) : request
  const target = { rowIncarnation: row.rowIncarnation, ownerId: row.ownerId, provider: row.provider }
  try {
    const configured = await resolveControlPlaneFetcher({
      override: row.proxyFallbackList ?? [], upstreamId: row.id, runtimeLocation: getRuntimeLocation(),
    })
    const fetcher = configured ?? directFetcher
    await ensureCodexAccessToken(row.id, account.accountId, async (refreshToken, mintSignal) => {
      const latest = await readCodexCredential(row.id, account.accountId, target)
      if (latest.credential.credentialRevision !== account.revision) throw new UpstreamContentionError(row.id)
      return mintCodexAccessToken(refreshToken, fetcher, mintSignal)
    }, true, target, signal, fetcher)
    if (signal.aborted) return errorResponse("Credential refresh canceled", 499)
    const current = await loadOwned(auth, () => getRepo().upstreams.getById(id))
    if (!current || current.rowIncarnation !== row.rowIncarnation || current.ownerId !== row.ownerId || current.provider !== "codex") {
      return errorResponse("upstream not found", 404)
    }
    if (targetAccount(current)?.revision !== account.revision) return errorResponse("Credential target changed", 409)
    return c.json({ upstream: serializeUpstream(current) })
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return errorResponse("Credential refresh canceled", 499)
    if (error instanceof UpstreamGoneError || error instanceof UpstreamReplacedError) return errorResponse("upstream not found", 404)
    if (error instanceof UpstreamContentionError) return errorResponse("Credential target changed", 409)
    if (error instanceof CodexNonrenewableCredentialError) return errorResponse("Codex credential cannot be refreshed", 409)
    return errorResponse("Credential refresh failed", 502)
  }
})
