/**
 * API key helpers — thin facade over Repo.apiKeys.
 *
 * Ported 1:1 from old src/lib/api-keys.ts. Logic unchanged; only the import
 * paths are rewritten to vnext layout. webSearchEnabled defaults to true at
 * creation time to match the legacy default — control-plane PATCH flips it
 * off when an admin disables web search for a given key.
 */
import { getRepo } from '../../shared/repo/index.ts'
import type { ApiKey } from '../../shared/repo/types.ts'

export type { ApiKey }

function generateKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function createApiKey(name: string, ownerId?: string): Promise<ApiKey> {
  const key: ApiKey = {
    id: crypto.randomUUID(),
    name,
    key: generateKey(),
    createdAt: new Date().toISOString(),
    ownerId,
    webSearchEnabled: true,
  }
  await getRepo().apiKeys.save(key)
  return key
}

export function listApiKeys(): Promise<ApiKey[]> {
  return getRepo().apiKeys.list()
}

export function listApiKeysByOwner(ownerId: string): Promise<ApiKey[]> {
  return getRepo().apiKeys.listByOwner(ownerId)
}

export function getApiKeyById(id: string): Promise<ApiKey | null> {
  return getRepo().apiKeys.getById(id)
}

export async function renameApiKey(id: string, name: string): Promise<ApiKey | null> {
  const existing = await getRepo().apiKeys.getById(id)
  if (!existing) return null
  const updated = { ...existing, name }
  await getRepo().apiKeys.save(updated)
  return updated
}

export async function rotateApiKey(id: string): Promise<ApiKey | null> {
  const existing = await getRepo().apiKeys.getById(id)
  if (!existing) return null
  const updated = { ...existing, key: generateKey() }
  await getRepo().apiKeys.save(updated)
  return updated
}

export function deleteApiKey(id: string): Promise<boolean> {
  return getRepo().apiKeys.delete(id)
}

export async function validateApiKey(
  rawKey: string,
): Promise<{ id: string; name: string; ownerId?: string } | null> {
  const key = await getRepo().apiKeys.findByRawKey(rawKey)
  if (!key) return null
  return { id: key.id, name: key.name, ownerId: key.ownerId }
}

export async function touchApiKeyLastUsed(id: string): Promise<void> {
  const existing = await getRepo().apiKeys.getById(id)
  if (!existing) return
  await getRepo().apiKeys.save({
    ...existing,
    lastUsedAt: new Date().toISOString(),
  })
}
