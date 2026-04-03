import { getRepo, type GitHubAccount, type GitHubUser } from "~/repo"

export type { GitHubAccount, GitHubUser }

interface GithubCredentials {
  token: string
  accountType: string
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
}

export async function removeGithubAccount(userId: number, ownerId?: string): Promise<void> {
  const repo = getRepo().github
  await repo.deleteAccount(userId, ownerId ?? "")
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
  return { token: account.token, accountType: account.accountType }
}

// === Per-user ===

export function listGithubAccountsForUser(ownerId: string): Promise<GitHubAccount[]> {
  return getRepo().github.listAccountsByOwner(ownerId)
}
