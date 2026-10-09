import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { UpstreamRepo } from "../../repo/types"
import type { UpstreamId } from "../../repo/branded-ids"

const encoder = new TextEncoder()
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** Local IDs still fence execution. Only a proven account/model may gain a
 * portable declaration, namespaced by the API key's shared secret. */
export function sharedSessionTargetDecorator(secret: Uint8Array, ownerId: string, repo: UpstreamRepo): (target: AffinityExecutionTarget) => Promise<AffinityExecutionTarget> {
  const key = crypto.subtle.importKey("raw", new Uint8Array(secret).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const memo = new Map<string, Promise<AffinityExecutionTarget>>()
  const decorate = async (target: AffinityExecutionTarget): Promise<AffinityExecutionTarget> => {
    if (target.provider !== "copilot") return target
    // This conversion is the boundary between provider wire identities and repo IDs.
    const row = await repo.getById(target.upstreamId as UpstreamId)
    if (!row?.enabled || row.ownerId !== ownerId || row.provider !== target.provider
      || row.rowIncarnation !== target.upstreamIncarnation || String(row.catalogGeneration) !== target.credentialRevision
      || target.credentialSubject !== `upstream:${row.id}`) return target
    const config = row.config
    if (!record(config) || !record(config.user) || !Number.isSafeInteger(config.user.id) || Number(config.user.id) <= 0
      || typeof config.githubToken !== "string" || !config.githubToken
      || !["individual", "business", "enterprise"].includes(String(config.accountType))) return target
    const host = config.githubHost ?? "github.com"
    if (typeof host !== "string" || !/^[a-z0-9.-]+$/i.test(host)) return target
    const state = record(row.state) ? row.state : {}
    const endpoint = state.copilotApiEndpoint ?? (config.accountType === "individual" ? "https://api.githubcopilot.com" : `https://api.${config.accountType}.githubcopilot.com`)
    if (typeof endpoint !== "string") return target
    const identity = JSON.stringify(["vnext/shared-session/copilot-account/v1", host.toLowerCase(), config.user.id, config.accountType, endpoint.replace(/\/$/, ""), target.model])
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", await key, encoder.encode(identity)))
    const fingerprint = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
    return { ...target, compatibility: { version: 1, scope: "owner", key: `shared-session-v1:${fingerprint}` } }
  }
  return target => {
    const id = JSON.stringify(target)
    let pending = memo.get(id)
    if (!pending) { pending = decorate(target); memo.set(id, pending) }
    return pending
  }
}
