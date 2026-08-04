import type { Repo } from "./types"
import { __registerPlatformReset } from "@vibe-core/platform"
import { initUpstreamRepo } from "@vibe-core/upstream-repo"

export type {
  Repo, ApiKey, GitHubAccount, GitHubUser, UpstreamRecord, UpstreamRepo,
  UsageRecord, LatencyRecord, User, InviteCode, UserSession, ClientPresence,
  WebSearchUsageRecord, ObservabilityShare, ObservabilityShareRepo,
} from "./types"

let _repo: Repo | null = null
__registerPlatformReset(() => { _repo = null })

export function initRepo(repo: Repo): void {
  _repo = repo
  // Wire the provider-facing lazy accessor. The closure re-resolves
  // `getRepo()` on every read, so provider plugins (e.g. codex) stay pinned
  // to the current live repo. Re-registering on every `initRepo` is
  // idempotent — needed because platform test-reset clears the accessor in
  // `@vibe-core/upstream-repo` too.
  initUpstreamRepo(() => getRepo().upstreams)
}

export function getRepo(): Repo {
  if (!_repo) throw new Error("Repo not initialized; call initRepo() first")
  return _repo
}
