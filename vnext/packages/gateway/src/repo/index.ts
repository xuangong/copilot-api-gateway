import { AsyncLocalStorage } from "node:async_hooks"
import { ConfigurationCache, observeConfigurationWrites } from "./configuration-cache.ts"
import { authoritativeConfigurationReads, type DataPlaneConfiguration } from "./configuration-ports.ts"
import { cachedProxyHealth } from "./proxy-health-cache.ts"
import type { Repo } from "./types"
import { __registerPlatformReset } from "@vibe-core/platform"
import { initUpstreamRepo } from "@vibe-core/upstream-repo"

export type {
  Repo, ApiKey, GitHubAccount, GitHubUser, UpstreamRecord, UpstreamRepo,
  UsageRecord, LatencyRecord, User, InviteCode, UserSession, ClientPresence,
  WebSearchUsageRecord, ObservabilityShare, ObservabilityShareRepo,
} from "./types"
export type { DataPlaneConfiguration } from "./configuration-ports.ts"

let _repo: Repo | null = null
let configuration: ConfigurationCache | undefined
let currentConfiguration: DataPlaneConfiguration | undefined
let proxyHealth: Repo["proxyBackoffs"] | undefined
const requestConfiguration = new AsyncLocalStorage<DataPlaneConfiguration>()
__registerPlatformReset(() => { _repo = null; configuration = undefined; currentConfiguration = undefined; proxyHealth = undefined })

export function initRepo(repo: Repo): void {
  _repo = repo
  configuration = repo.configurationRevision ? new ConfigurationCache(repo) : undefined
  currentConfiguration = configuration?.view ?? authoritativeConfigurationReads(repo)
  proxyHealth = configuration ? cachedProxyHealth(repo.proxyBackoffs) : repo.proxyBackoffs
  if (configuration) {
    const cache = configuration
    observeConfigurationWrites(repo, () => cache.invalidate(), id => cache.refreshUpstream(id))
  }
  // Wire the provider-facing lazy accessor. The closure re-resolves
  // `getRepo()` on every read, so provider plugins (e.g. codex) stay pinned
  // to the current live repo. Re-registering on every `initRepo` is
  // idempotent — needed because platform test-reset clears the accessor in
  // `@vibe-core/upstream-repo` too.
  initUpstreamRepo(() => ({
    // Renewable credentials use the current view, never the request's pinned
    // routing view. State commands keep their authoritative CAS implementation.
    getById: getCurrentConfiguration().upstreams.getById,
    saveState: getRepo().upstreams.saveState.bind(getRepo().upstreams),
  }), () => {
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

function getCurrentConfiguration(): DataPlaneConfiguration {
  if (!currentConfiguration) throw new Error("Repo not initialized; call initRepo() first")
  return currentConfiguration
}

/** Request-pinned configuration reads; live commands use getRepo(). */
export function getDataPlaneConfiguration(): DataPlaneConfiguration {
  return requestConfiguration.getStore() ?? getCurrentConfiguration()
}

/** Advisory dial state has its own bounded cache and live command semantics. */
export function getProxyHealth(): Repo["proxyBackoffs"] {
  if (!proxyHealth) throw new Error("Repo not initialized; call initRepo() first")
  return proxyHealth
}

export async function withConfigurationSnapshot<T>(run: () => Promise<T>): Promise<T> {
  if (!configuration) return run()
  return requestConfiguration.run(await configuration.pinnedView(), run)
}

/** Per-message authority for long-lived transports; ordinary HTTP keeps its lease. */
export async function withFreshConfigurationSnapshot<T>(run: () => Promise<T>): Promise<T> {
  return requestConfiguration.run(configuration ? await configuration.freshPinnedView() : getCurrentConfiguration(), run)
}

export function hasConfigurationSnapshot(): boolean { return requestConfiguration.getStore() !== undefined }
