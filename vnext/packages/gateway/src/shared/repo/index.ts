import type { Repo } from "./types"
import { __registerPlatformReset } from "@vnext-gateway/platform"

export type {
  Repo, ApiKey, GitHubAccount, GitHubUser, UpstreamRecord, UpstreamRepo,
  UsageRecord, LatencyRecord, User, InviteCode, UserSession, ClientPresence,
  WebSearchUsageRecord, ObservabilityShare, ObservabilityShareRepo,
} from "./types"

let _repo: Repo | null = null
__registerPlatformReset(() => { _repo = null })

export function initRepo(repo: Repo): void {
  _repo = repo
}

export function getRepo(): Repo {
  if (!_repo) throw new Error("Repo not initialized; call initRepo() first")
  return _repo
}
