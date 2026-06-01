import { getRepo, type GitHubAccount, type GitHubUser, type UpstreamRecord } from "~/repo"

export type { GitHubAccount, GitHubUser }

interface GithubCredentials {
  token: string
  accountType: string
  userId: number
  flagOverrides?: Record<string, boolean>
}

// Mirror a copilot GitHub account into the `upstreams` registry so it shows
// up alongside Custom/Azure in the unified dashboard. Boot-time
// `ensureUpstreams()` does the same backfill from existing rows; this
// keeps the two stores in sync after runtime device-flow auth so the new
// account appears immediately without a server restart.
export function copilotUpstreamRowId(ownerId: string, userId: number): string {
  return `up_copilot_${ownerId || "global"}_${userId}`.replace(/[^a-zA-Z0-9_-]/g, "_")
}

async function mirrorCopilotUpstream(
  token: string,
  user: GitHubUser,
  accountType: string,
  ownerId: string,
): Promise<void> {
  const id = copilotUpstreamRowId(ownerId, user.id)
  const existing = await getRepo().upstreams.getById(id)
  const now = new Date().toISOString()
  const record: UpstreamRecord = {
    id,
    ownerId,
    provider: "copilot",
    name: existing?.name ?? user.login ?? `Copilot ${user.id}`,
    enabled: existing?.enabled ?? true,
    sortOrder: existing?.sortOrder ?? 0,
    // Keep flag overrides on update; rebuild config with the fresh token.
    config: {
      githubToken: token,
      accountType,
      user: { id: user.id, login: user.login, name: user.name, avatar_url: user.avatar_url },
    },
    flagOverrides: existing?.flagOverrides ?? {},
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await getRepo().upstreams.save(record)
  // Dynamic import to avoid a registry → repo → lib/github cycle that
  // breaks test ESM evaluation order.
  const { invalidateUpstreamListCache } = await import("~/providers/registry")
  invalidateUpstreamListCache()
}

// === Global (admin / legacy) ===

export function listGithubAccounts(): Promise<GitHubAccount[]> {
  return getRepo().github.listAccounts()
}

export async function addGithubAccount(
  token: string,
  user: GitHubUser,
  accountType: string,
  ownerId?: string,
): Promise<void> {
  const repo = getRepo().github
  await repo.saveAccount(user.id, { token, accountType, user, ownerId })
  if (ownerId) {
    await repo.setActiveIdForUser(ownerId, user.id)
  } else {
    await repo.setActiveId(user.id)
  }
  await mirrorCopilotUpstream(token, user, accountType, ownerId ?? "")
}

export async function removeGithubAccount(userId: number, ownerId?: string): Promise<void> {
  const repo = getRepo().github
  await repo.deleteAccount(userId, ownerId ?? "")
  // Cascade-delete the mirrored upstream row so the unified list doesn't
  // show stale entries with a now-invalid token.
  await getRepo().upstreams.delete(copilotUpstreamRowId(ownerId ?? "", userId))
  const { invalidateUpstreamListCache } = await import("~/providers/registry")
  invalidateUpstreamListCache()
  if (ownerId) {
    const activeId = await repo.getActiveIdForUser(ownerId)
    if (activeId === userId) {
      await repo.clearActiveIdForUser(ownerId)
    }
  } else {
    const activeId = await repo.getActiveId()
    if (activeId === userId) {
      await repo.clearActiveId()
    }
  }
}

export async function setActiveGithubAccount(userId: number, ownerId?: string): Promise<boolean> {
  const repo = getRepo().github
  const account = await repo.getAccount(userId, ownerId ?? "")
  if (!account) return false
  if (ownerId) {
    await repo.setActiveIdForUser(ownerId, userId)
  } else {
    await repo.setActiveId(userId)
  }
  return true
}

export async function getActiveGithubAccount(ownerId?: string): Promise<GitHubAccount | null> {
  const repo = getRepo().github
  const activeId = ownerId
    ? await repo.getActiveIdForUser(ownerId)
    : await repo.getActiveId()
  if (activeId == null) return null
  return repo.getAccount(activeId, ownerId ?? "")
}

export async function getGithubCredentials(ownerId?: string): Promise<GithubCredentials> {
  const account = await getActiveGithubAccount(ownerId)
  if (!account) throw new Error("No GitHub account connected. Use /auth/github to connect.")
  return {
    token: account.token,
    accountType: account.accountType,
    userId: account.user.id,
    flagOverrides: account.flagOverrides,
  }
}

// === Per-user ===

export function listGithubAccountsForUser(ownerId: string): Promise<GitHubAccount[]> {
  return getRepo().github.listAccountsByOwner(ownerId)
}
