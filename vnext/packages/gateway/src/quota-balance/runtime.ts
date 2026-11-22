// packages/gateway/src/quota-balance/runtime.ts
import { __registerPlatformReset } from "@vibe-core/platform"
import type { Fetcher } from "@vibe-core/upstream"
import { getProtection, type ProtectionRuntime } from "../protection/runtime.ts"
import { balanceCandidates, type BalanceArgs, type BalanceOutcome } from "./balance.ts"
import { AssignmentStore } from "./assignments.ts"
import { QuotaCostTracker } from "./cost-tracker.ts"
import { QuotaCutoff } from "./cutoff.ts"
import { defaultDeps, type QuotaDeps } from "./deps.ts"
import { GroupDirectoryCache } from "./directory.ts"
import { MemberFactsCache } from "./facts.ts"
import { QuotaReader } from "./reader.ts"

type FetcherFactory = (upstreamId: string) => Promise<Fetcher>
/** Fails closed: a read must leave through the member's own proxy chain, never directly from this process. */
const unconfigured: FetcherFactory = async () => { throw new Error("quota fetcher not configured") }
let fetcherFactory: FetcherFactory = unconfigured
/** The composition roots (`app.ts`, `maintenance.ts`) import `control-plane/quota-balance/fetcher.ts`, which registers the proxy-chain aware factory; until then every read fails and is recorded as a failure. */
export function setQuotaFetcherFactory(factory: FetcherFactory | null): void { fetcherFactory = factory ?? unconfigured }

/** The per-isolate quota-balance services, sharing one set of caches. */
export class QuotaBalance {
  readonly directory: GroupDirectoryCache
  readonly facts: MemberFactsCache
  readonly assignments: AssignmentStore
  readonly cutoff: QuotaCutoff
  readonly reader: QuotaReader
  readonly costs: QuotaCostTracker

  constructor(readonly deps: QuotaDeps = defaultDeps(), options: { protection?: () => ProtectionRuntime } = {}) {
    this.directory = new GroupDirectoryCache(deps)
    this.facts = new MemberFactsCache(deps)
    this.assignments = new AssignmentStore(deps)
    this.cutoff = new QuotaCutoff(deps, options.protection ?? getProtection)
    this.reader = new QuotaReader(deps, { directory: this.directory, facts: this.facts, cutoff: this.cutoff, fetcherFor: id => fetcherFactory(id) })
    this.costs = new QuotaCostTracker(deps, { directory: this.directory, facts: this.facts, assignments: this.assignments, evaluate: id => this.reader.evaluateSoon(id) })
  }

  /** Orders the candidates of every group for this request (see balance.ts). Fail-open. */
  balance<T>(args: BalanceArgs<T>): Promise<BalanceOutcome<T>> { return balanceCandidates(this, args) }
}

let current: QuotaBalance | null = null
/** The process-wide services: real repo, wall clock, `waitUntil`. */
export function getQuotaBalance(): QuotaBalance { return current ??= new QuotaBalance() }
export function setQuotaBalanceForTests(value: QuotaBalance | null): void { current = value }
__registerPlatformReset(() => { current = null })
