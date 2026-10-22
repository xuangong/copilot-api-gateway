import { z } from "zod"
import { LokiSyncError, LOKI_PROFILE_ID, type LokiState, publicLokiStatus } from "@vibe-llm/provider-loki"
import { UpstreamGoneError, UpstreamReplacedError, UpstreamContentionError } from "@vibe-core/upstream-repo"
import type { UpstreamId, UserId } from "../../repo/branded-ids"

export const upstreamId = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/).transform(value => value as UpstreamId)
export const ownerId = z.string().min(1).max(256).transform(value => value as UserId)
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
})
export function safeError(error: unknown): Response {
  if (error instanceof LokiSyncError) return json({ error: { code: error.code } }, error.status)
  if (error instanceof UpstreamGoneError || error instanceof UpstreamReplacedError) return json({ error: { code: "binding_replaced" } }, 409)
  if (error instanceof UpstreamContentionError) return json({ error: { code: "revision_conflict" } }, 409)
  return json({ error: { code: "temporarily_unavailable" } }, 503)
}
export async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new LokiSyncError("invalid_request", 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 65_536) throw new LokiSyncError("body_too_large", 413)
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }
  catch { throw new LokiSyncError("invalid_request", 400) }
}
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")
}
export async function newBinding(): Promise<{ state: LokiState; syncSecret: string }> {
  const syncSecret = `lks_${Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("")}`
  return { syncSecret, state: { version: 1, profileId: LOKI_PROFILE_ID, generation: crypto.randomUUID(),
    syncSecretHash: await digest(syncSecret), revision: 0, assistantStatus: "waiting" } }
}
export const statusResponse = (state: LokiState) => json({ version: 1, profileId: state.profileId,
  generation: state.generation, revision: state.revision, ...publicLokiStatus(state) })
