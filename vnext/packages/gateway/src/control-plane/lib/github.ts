/**
 * GitHub accounts lib — Week 5b port of src/lib/github.ts.
 *
 * Wraps repo.github with the "also mirror into upstreams registry" side-effect
 * so device-flow-added accounts appear in the unified upstream list immediately
 * without a server restart.
 */
import { getRepo } from '../../repo/index.ts'
import type {
  GitHubAccount,
  GitHubUser,
  ProxyFallbackEntry,
  UpstreamRecord,
} from '../../repo/types.ts'
import type { GitHubAccountId, UpstreamId, UserId } from '../../repo/branded-ids.ts'
import { UpstreamGoneError, UpstreamReplacedError } from '@vibe-core/upstream-repo'
import { normalizeProxyFallbackList } from '@vibe-core/proxy-repo'

export type { GitHubAccount, GitHubUser }

export interface GithubCredentials {
  token: string
  accountType: string
  userId: GitHubAccountId
  flagOverrides?: Record<string, boolean>
}

export interface AddGithubAccountOpts {
  githubHost?: string
  source?: 'device-flow' | 'paste'
  copilotApiEndpoint?: string
  /**
   * Chain to store on the mirrored upstream row. Absent = keep whatever the
   * row already has (a re-login must not wipe a later edit); present-but-empty
   * = the user deliberately chose direct. A present list is run through
   * `normalizeProxyFallbackList` before storage, so colo codes reach the row
   * uppercased and duplicate ids are dropped.
   */
  proxyFallbackList?: ProxyFallbackEntry[]
}

export function copilotUpstreamRowId(ownerId: UserId | '', userId: GitHubAccountId): UpstreamId {
  return `up_copilot_${ownerId || 'global'}_${userId}`.replace(/[^a-zA-Z0-9_-]/g, '_') as UpstreamId
}

async function mirrorCopilotUpstream(
  token: string,
  user: GitHubUser,
  accountType: string,
  ownerId: UserId | '',
  opts: AddGithubAccountOpts = {},
): Promise<void> {
  const id = copilotUpstreamRowId(ownerId, user.id)
  const repo = getRepo().upstreams
  let existing = await repo.getById(id)
  const now = new Date().toISOString()
  const config = {
    githubToken: token, accountType,
    user: { id: user.id, login: user.login, name: user.name, avatar_url: user.avatar_url },
    ...(opts.githubHost ? { githubHost: opts.githubHost } : {}),
    ...(opts.source ? { source: opts.source } : {}),
  }
  const chain = opts.proxyFallbackList === undefined ? undefined : normalizeProxyFallbackList(opts.proxyFallbackList)
  if (!existing) {
    const record: UpstreamRecord<unknown> = {
      id, ownerId: ownerId || undefined, provider: 'copilot', name: user.login || `Copilot ${user.id}`,
      enabled: true, sortOrder: 0, config, flagOverrides: {}, disabledPublicModelIds: [],
      state: opts.copilotApiEndpoint ? { copilotApiEndpoint: opts.copilotApiEndpoint } : null,
      proxyFallbackList: chain ?? [], createdAt: now, updatedAt: now,
    }
    if (await repo.createIfAbsent(record)) return
    existing = await repo.getById(id)
    if (!existing) throw new UpstreamGoneError(id)
  }
  if (existing.provider !== 'copilot' || (existing.ownerId || '') !== ownerId) throw new UpstreamReplacedError(id)
  const updated = await repo.patchMetadata(existing, current => ({
    ...current, config, proxyFallbackList: chain ?? current.proxyFallbackList,
  }))
  if (opts.copilotApiEndpoint) {
    const endpoint = opts.copilotApiEndpoint
    await repo.saveState<Record<string, unknown> | null>(id, current => ({ ...current, copilotApiEndpoint: endpoint }), updated)
  }
}

// === Global (admin / legacy) ===

export function listGithubAccounts(): Promise<GitHubAccount[]> {
  return getRepo().github.listAccounts()
}

export async function addGithubAccount(
  token: string,
  user: GitHubUser,
  accountType: string,
  ownerId?: UserId,
  opts: AddGithubAccountOpts = {},
): Promise<void> {
  const repo = getRepo().github
  await repo.saveAccount(user.id, {
    token,
    accountType,
    user,
    ownerId,
    enabled: true,
    sortOrder: 0,
    flagOverrides: {},
    updatedAt: undefined,
    githubHost: opts.githubHost,
    source: opts.source,
  })
  if (ownerId) {
    await repo.setActiveIdForUser(ownerId, user.id)
  } else {
    await repo.setActiveId(user.id)
  }
  await mirrorCopilotUpstream(token, user, accountType, ownerId ?? '', opts)
}

export async function removeGithubAccount(
  userId: GitHubAccountId,
  ownerId?: UserId,
): Promise<void> {
  const repo = getRepo().github
  await repo.deleteAccount(userId, ownerId)
  await getRepo().upstreams.delete(copilotUpstreamRowId(ownerId ?? '', userId))
  if (ownerId) {
    const activeId = await repo.getActiveIdForUser(ownerId)
    if (activeId === userId) await repo.clearActiveIdForUser(ownerId)
  } else {
    const activeId = await repo.getActiveId()
    if (activeId === userId) await repo.clearActiveId()
  }
}

export async function setActiveGithubAccount(
  userId: GitHubAccountId,
  ownerId?: UserId,
): Promise<boolean> {
  const repo = getRepo().github
  const account = await repo.getAccount(userId, ownerId)
  if (!account) return false
  if (ownerId) {
    await repo.setActiveIdForUser(ownerId, userId)
  } else {
    await repo.setActiveId(userId)
  }
  return true
}

export function listGithubAccountsForUser(
  ownerId: UserId,
): Promise<GitHubAccount[]> {
  return getRepo().github.listAccountsByOwner(ownerId)
}
