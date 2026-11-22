// packages/gateway/src/control-plane/quota-balance/fetcher.ts
import { getRuntimeLocation } from "@vibe-core/platform"
import { setQuotaFetcherFactory } from "../../quota-balance/runtime.ts"
import { resolveControlPlaneFetcher } from "../upstreams/proxy-resolution.ts"

/** The member's own egress: its saved proxy chain, as the Users page quota read uses it; plain `fetch` when it has none. Imported for its effect. */
setQuotaFetcherFactory(async upstreamId => (await resolveControlPlaneFetcher({ upstreamId, runtimeLocation: getRuntimeLocation() })) ?? fetch)
