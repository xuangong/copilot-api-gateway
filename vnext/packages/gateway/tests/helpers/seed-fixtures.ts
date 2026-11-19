import type { ApiKeyId, UserId } from '../../src/repo/branded-ids.ts'
import type { ApiKey, Repo } from '../../src/repo/types.ts'

/** Store an API key row in a real repo (e.g. the one from `setupTestPlatform()`). */
export async function seedApiKey(
  repo: Pick<Repo, 'apiKeys'>,
  key: Partial<Omit<ApiKey, 'id' | 'ownerId'>> & { key: string; id?: string; ownerId?: string },
): Promise<ApiKey> {
  const row: ApiKey = {
    modelMappingsEnabled: false,
    modelMappings: [],
    createdAt: '2026-01-01T00:00:00Z',
    name: 'fixture',
    ...key,
    id: (key.id ?? 'k1') as ApiKeyId,
    ownerId: key.ownerId as UserId | undefined,
  }
  await repo.apiKeys.save(row)
  return row
}
