/**
 * GitHub accounts lib — Week 5b port of src/lib/github.ts.
 *
 * Wraps repo.github with the "also mirror into upstreams registry" side-effect
 * so device-flow-added accounts appear in the unified upstream list immediately
 * without a server restart.
 */
import { getRepo } from '../repo/index.ts'
import type {
  GitHubAccount,
  GitHubUser,
  UpstreamRecord,
} from '../repo/types.ts'
import type { GitHubAccountId, UpstreamId, UserId } from '../repo/branded-ids.ts'

export type { GitHubAccount, GitHubUser }

export interface GithubCredentials {
  token: string
  accountType: string
  userId: GitHubAccountId
  flagOverrides?: Record<string, boolean>
}

export function copilotUpstreamRowId(ownerId: UserId | '', userId: GitHubAccountId): UpstreamId {
  return `up_copilot_${ownerId || 'global'}_${userId}`.replace(/[^a-zA-Z0-9_-]/g, '_') as UpstreamId
}

async function mirrorCopilotUpstream(
  token: string,
  user: GitHubUser,
  accountType: string,
  ownerId: UserId | '',
  opts: { githubHost?: string; source?: 'device-flow' | 'paste'; copilotApiEndpoint?: string } = {},
): Promise<void> {
  const id = copilotUpstreamRowId(ownerId, user.id)
  const existing = await getRepo().upstreams.getById(id)
  const now = new Date().toISOString()
  const record: UpstreamRecord<unknown> = {
    id,
    ownerId: ownerId || undefined,
    provider: 'copilot',
    name: existing?.name ?? user.login ?? `Copilot ${user.id}`,
    enabled: existing?.enabled ?? true,
    sortOrder: existing?.sortOrder ?? 0,
    config: {
      githubToken: token,
      accountType,
      user: {
        id: user.id,
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
      },
      ...(opts.githubHost ? { githubHost: opts.githubHost } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    },
    flagOverrides: existing?.flagOverrides ?? {},
    disabledPublicModelIds: existing?.disabledPublicModelIds ?? [],
    state: opts.copilotApiEndpoint
      ? { ...((existing?.state as Record<string, unknown> | null) ?? {}), copilotApiEndpoint: opts.copilotApiEndpoint }
      : (existing?.state ?? null),
    proxyFallbackList: existing?.proxyFallbackList ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await getRepo().upstreams.save(record)
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
  opts: { githubHost?: string; source?: 'device-flow' | 'paste'; copilotApiEndpoint?: string } = {},
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
