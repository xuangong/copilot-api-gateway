/**
 * Repo-backed entry point for per-key web search.
 *
 * `key-config.ts` stays free of repo access so its rules are testable on their
 * own; this module supplies the three lookups it needs — the calling key, keys
 * it borrows credentials from, and the Copilot upstream whose GitHub token the
 * copilot engine searches with.
 */

import { getRepo } from '../../../repo/index.ts'
import type { ApiKeyId } from '../../../repo/branded-ids.ts'
import { pickCopilotSearchToken, resolveKeyWebSearch, type KeyWebSearchResolution } from './key-config.ts'

/**
 * Resolves the web-search provider for a request's API key.
 *
 * A missing or unknown key id resolves to `disabled` rather than raising: the
 * shims treat that exactly like a key with the switch off, dropping the hosted
 * tool and letting the model answer.
 */
export const resolveWebSearchForKey = async (
  apiKeyId: ApiKeyId | undefined,
): Promise<KeyWebSearchResolution> => {
  if (!apiKeyId) return { type: 'disabled' }
  const repo = getRepo()
  const key = await repo.apiKeys.getById(apiKeyId).catch(() => null)
  if (!key) return { type: 'disabled' }

  return await resolveKeyWebSearch(
    key,
    (id) => repo.apiKeys.getById(id as ApiKeyId),
    async () => pickCopilotSearchToken(await repo.upstreams.list({ includeDisabled: true })),
    // Borrowing is scoped to keys the borrower's owner can see. Admin-owned
    // and same-owner keys qualify; a key owned by someone else does not.
    async (source, borrowerOwnerId) =>
      source.ownerId === undefined || source.ownerId === borrowerOwnerId,
  )
}
