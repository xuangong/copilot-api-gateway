import { AsyncLocalStorage } from "node:async_hooks"
import { ConfigurationCache, observeConfigurationWrites } from "./configuration-cache.ts"
import type { Repo } from "./types"
import { __registerPlatformReset } from "@vibe-core/platform"
import { initUpstreamRepo } from "@vibe-core/upstream-repo"

export type {
  Repo, ApiKey, GitHubAccount, GitHubUser, UpstreamRecord, UpstreamRepo,
  UsageRecord, LatencyRecord, User, InviteCode, UserSession, ClientPresence,
  WebSearchUsageRecord, ObservabilityShare, ObservabilityShareRepo,
} from "./types"

let _repo: Repo | null = null
let configuration: ConfigurationCache | undefined
const requestRepo = new AsyncLocalStorage<Repo>()
__registerPlatformReset(() => { _repo = null; configuration = undefined })

export function initRepo(repo: Repo): void {
  _repo = repo
  configuration = repo.configurationRevision ? new ConfigurationCache(repo) : undefined
  if (configuration) {
    const cache = configuration
    observeConfigurationWrites(repo, () => cache.invalidate(), id => cache.refreshUpstream(id))
  }
  // Wire the provider-facing lazy accessor. The closure re-resolves
  // `getRepo()` on every read, so provider plugins (e.g. codex) stay pinned
  // to the current live repo. Re-registering on every `initRepo` is
  // idempotent — needed because platform test-reset clears the accessor in
  // `@vibe-core/upstream-repo` too.
  initUpstreamRepo(() => (configuration?.view ?? getRepo()).upstreams, () => {
    const raw = getRepo().upstreams
    const cache = configuration
    if (!cache) return raw
    // A recovery read also updates the local row so subsequent requests use
    // the sibling's winning credential instead of repeating the failed refresh.
    return new Proxy(raw, {
      get(target, name) {
        if (name === "getById") return cache.refreshUpstream.bind(cache)
        const value = Reflect.get(target, name)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  })
}

export function getRepo(): Repo {
  if (!_repo) throw new Error("Repo not initialized; call initRepo() first")
  return _repo
}

/** Shared read-mostly configuration; mutations and non-config data remain authoritative. */
export function getDataPlaneRepo(): Repo {
  return requestRepo.getStore() ?? configuration?.view ?? getRepo()
}

export async function withConfigurationSnapshot<T>(run: () => Promise<T>): Promise<T> {
  if (!configuration) return run()
  return requestRepo.run(await configuration.pinnedView(), run)
}

export function hasConfigurationSnapshot(): boolean { return requestRepo.getStore() !== undefined }
