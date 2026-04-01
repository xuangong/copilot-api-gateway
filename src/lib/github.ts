import { getRepo, type GitHubAccount, type GitHubUser } from "~/repo"

export type { GitHubAccount, GitHubUser }

interface GithubCredentials {
  token: string
  accountType: string
}

export function listGithubAccounts(): Promise<GitHubAccount[]> {
  return getRepo().github.listAccounts()
}

export async function addGithubAccount(
  token: string,
  user: GitHubUser,
  accountType: string,
): Promise<void> {
  const repo = getRepo().github
  await repo.saveAccount(user.id, { token, accountType, user })
  await repo.setActiveId(user.id)
}

export async function removeGithubAccount(userId: number): Promise<void> {
  const repo = getRepo().github
  await repo.deleteAccount(userId)
  const activeId = await repo.getActiveId()
  if (activeId === userId) {
    await repo.clearActiveId()
  }
}

export async function setActiveGithubAccount(userId: number): Promise<boolean> {
  const repo = getRepo().github
  const account = await repo.getAccount(userId)
  if (!account) return false
  await repo.setActiveId(userId)
  return true
}

export async function getActiveGithubAccount(): Promise<GitHubAccount | null> {
  const repo = getRepo().github
  const activeId = await repo.getActiveId()
  if (activeId == null) return null
  return repo.getAccount(activeId)
}

export async function getGithubCredentials(): Promise<GithubCredentials> {
  const account = await getActiveGithubAccount()
  if (!account) throw new Error("No GitHub account connected. Use /auth/github to connect.")
  return { token: account.token, accountType: account.accountType }
}
