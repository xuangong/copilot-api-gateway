import type { Repo } from "./types.ts"

/** Request-pinned authorization and routing reads. Commands, operational state
 * and authoritative recovery reads must use their separate live owners. */
export interface DataPlaneConfiguration {
  readonly apiKeys: Readonly<Pick<Repo["apiKeys"], "findByRawKey" | "getById" | "list" | "listByOwner">>
  readonly users: Readonly<Pick<Repo["users"], "getById" | "findByKey">>
  readonly sessions: Readonly<Pick<Repo["sessions"], "findByToken">>
  readonly upstreams: Readonly<Pick<Repo["upstreams"], "getById" | "list">>
  readonly proxies: Readonly<Pick<Repo["proxies"], "getById" | "list">>
}

/** Repositories without revisions keep live reads, with the same read-only
 * capability surface as a cached snapshot. No command fallback is exposed. */
export function authoritativeConfigurationReads(repo: Repo): DataPlaneConfiguration {
  return {
    apiKeys: {
      findByRawKey: key => repo.apiKeys.findByRawKey(key),
      getById: id => repo.apiKeys.getById(id),
      list: () => repo.apiKeys.list(),
      listByOwner: id => repo.apiKeys.listByOwner(id),
    },
    users: {
      getById: id => repo.users.getById(id),
      findByKey: key => repo.users.findByKey(key),
    },
    sessions: { findByToken: token => repo.sessions.findByToken(token) },
    upstreams: {
      getById: id => repo.upstreams.getById(id),
      list: opts => repo.upstreams.list(opts),
    },
    proxies: {
      getById: id => repo.proxies.getById(id),
      list: () => repo.proxies.list(),
    },
  }
}
