/**
 * API key helpers — thin facade over Repo.apiKeys.
 *
 * Ported 1:1 from old src/lib/api-keys.ts. Logic unchanged; only the import
 * paths are rewritten to vnext layout. webSearchEnabled defaults to true at
 * creation time to match the legacy default — control-plane PATCH flips it
 * off when an admin disables web search for a given key.
 */
import { getRepo } from '../../repo/index.ts'
import type { ApiKey } from '../../repo/types.ts'
import { DEFAULT_API_KEY_MODEL_MAPPINGS } from '../../shared/api-key-model-mappings.ts'
import type { ApiKeyId, UserId } from '../../repo/branded-ids.ts'

export type { ApiKey }
export { validateApiKey, type ValidatedApiKey } from '../../shared/credential-auth.ts'

function cloneModelMappings(mappings: readonly { source: string; destination: string }[]) {
  return mappings.map((mapping) => ({ ...mapping }))
}

function generateKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function createApiKey(name: string, ownerId?: UserId): Promise<ApiKey> {
  const key: ApiKey = {
    id: crypto.randomUUID() as ApiKeyId,
    name,
    key: generateKey(),
    createdAt: new Date().toISOString(),
    ownerId,
    webSearchEnabled: true,
    responsesRetentionSeconds: 0,
    upstreamIds: null,
    modelMappingsEnabled: false,
    modelMappings: cloneModelMappings(DEFAULT_API_KEY_MODEL_MAPPINGS),
  }
  await getRepo().apiKeys.save(key)
  return key
}

export function listApiKeys(): Promise<ApiKey[]> {
  return getRepo().apiKeys.list()
}

export function listApiKeysByOwner(ownerId: UserId): Promise<ApiKey[]> {
  return getRepo().apiKeys.listByOwner(ownerId)
}

export function getApiKeyById(id: ApiKeyId): Promise<ApiKey | null> {
  return getRepo().apiKeys.getById(id)
}

export async function renameApiKey(id: ApiKeyId, name: string): Promise<ApiKey | null> {
  const repo = getRepo()
  if (!await repo.apiKeys.patch(id, { name })) return null
  return repo.apiKeys.getById(id)
}

export async function rotateApiKey(id: ApiKeyId): Promise<ApiKey | null> {
  const repo = getRepo()
  if (!await repo.apiKeys.patch(id, { key: generateKey() })) return null
  return repo.apiKeys.getById(id)
}

export function deleteApiKey(id: ApiKeyId): Promise<boolean> {
  return getRepo().apiKeys.delete(id)
}

export async function touchApiKeyLastUsed(id: ApiKeyId): Promise<void> {
  await getRepo().apiKeys.touchLastUsed(id)
}
