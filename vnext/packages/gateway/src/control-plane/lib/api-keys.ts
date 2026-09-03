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
import type { ApiKeyRoutingPolicy } from '../../shared/api-key-model-mappings.ts'
import { DEFAULT_API_KEY_MODEL_MAPPINGS } from '../../shared/api-key-model-mappings.ts'
import type { ApiKeyId, UserId } from '../../repo/branded-ids.ts'

export type { ApiKey }

export interface ValidatedApiKey {
  id: ApiKeyId
  name: string
  ownerId?: UserId
  routingPolicy: ApiKeyRoutingPolicy
}

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
  const existing = await getRepo().apiKeys.getById(id)
  if (!existing) return null
  const updated = { ...existing, name }
  await getRepo().apiKeys.save(updated)
  return updated
}

export async function rotateApiKey(id: ApiKeyId): Promise<ApiKey | null> {
  const existing = await getRepo().apiKeys.getById(id)
  if (!existing) return null
  const updated = { ...existing, key: generateKey() }
  await getRepo().apiKeys.save(updated)
  return updated
}

export function deleteApiKey(id: ApiKeyId): Promise<boolean> {
  return getRepo().apiKeys.delete(id)
}

export async function validateApiKey(rawKey: string): Promise<ValidatedApiKey | null> {
  const key = await getRepo().apiKeys.findByRawKey(rawKey)
  if (!key) return null
  const routingPolicy: ApiKeyRoutingPolicy = key.modelMappingsInvalid
    ? { modelMappingsEnabled: false, modelMappings: [] }
    : {
        modelMappingsEnabled: key.modelMappingsEnabled,
        modelMappings: cloneModelMappings(key.modelMappings),
      }
  return { id: key.id, name: key.name, ownerId: key.ownerId, routingPolicy }
}

export async function touchApiKeyLastUsed(id: ApiKeyId): Promise<void> {
  const existing = await getRepo().apiKeys.getById(id)
  if (!existing) return
  await getRepo().apiKeys.save({
    ...existing,
    lastUsedAt: new Date().toISOString(),
  })
}
