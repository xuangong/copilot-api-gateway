import type { UpstreamRecord } from '@vibe-core/upstream'

export type StoredUpstreamRecord<TState = unknown, TProvider extends string = string> =
  UpstreamRecord<TProvider, TState> & {
    rowIncarnation: string
    /** Authoritative configuration generation when supplied by the storage
     * adapter. Credential replacement/configuration changes advance it;
     * routine token/quota state updates do not. Absence grants no affinity. */
    catalogGeneration?: number
    /** Credential replacement advances this independent generation; routine
     * state updates and metadata/configuration changes do not. */
    credentialGeneration?: number
  }

export interface UpstreamWriteTarget {
  rowIncarnation: string
  ownerId?: string
  provider: string
  /** When supplied, state writes cannot cross a credential replacement. */
  credentialGeneration?: number
}

/**
 * Provider-facing upstream repo surface.
 *
 * Kept in a standalone package so provider plugins (e.g. `provider-codex`)
 * can rotate credential state without depending on `@vibe-core/gateway`
 * (which would create a cycle: gateway → provider-codex → gateway).
 *
 * The gateway's full `Repo.upstreams` is structurally compatible with this
 * interface and gets exposed through the accessor in `./accessor`.
 *
 * `id` is left as `string` here (matches `UpstreamRecord.id`). Callers that
 * hold a branded `UpstreamId` in the gateway can pass it directly.
 */
export interface UpstreamRepo {
  /**
   * `TState` defaults to `unknown` — untyped callers get an `unknown` state
   * they must narrow (usually via a provider-side assertion). Typed callers
   * pin the shape, e.g. `getById<CodexUpstreamState>(id)`.
   */
  getById<TState = unknown>(id: string): Promise<StoredUpstreamRecord<TState> | null>
  /**
   * Atomic read-modify-write of the `state` column. The updater sees the
   * current state coerced to `TState`; the return value replaces it. The pure,
   * synchronous updater may replay boundedly when another connection wins CAS.
   * Throws typed gone, replaced-target or contention errors. An optional target
   * fences a preceding authorized read across a multi-step operation.
   */
  saveState<TState>(id: string, updater: (current: TState) => TState, target?: UpstreamWriteTarget): Promise<void>
}
