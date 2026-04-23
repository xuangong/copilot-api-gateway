import type { Repo } from "./types"

export type { Repo, ApiKey, GitHubAccount, GitHubUser, UsageRecord, LatencyRecord, User, InviteCode, UserSession, ClientPresence, WebSearchUsageRecord, ObservabilityShare, ObservabilityShareRepo } from "./types"
export { D1Repo } from "./d1"

let _repo: Repo | null = null
let _override: Repo | null = null

export function initRepo(repo: Repo): void {
  _repo = repo
}

/** For use in tests only — overrides getRepo() without touching _repo */
export function setRepoForTest(r: Repo | null): void {
  _override = r
}

export function getRepo(): Repo {
  if (_override) return _override
  if (!_repo) throw new Error("Repo not initialized")
  return _repo
}
