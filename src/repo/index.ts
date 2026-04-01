import type { Repo } from "./types"

export type { Repo, ApiKey, GitHubAccount, GitHubUser, UsageRecord, LatencyRecord } from "./types"
export { D1Repo } from "./d1"

let _repo: Repo | null = null

export function initRepo(repo: Repo): void {
  _repo = repo
}

export function getRepo(): Repo {
  if (!_repo) throw new Error("Repo not initialized")
  return _repo
}
