import type { UpstreamRecord } from '@vibe-core/upstream'

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
  getById<TState = unknown>(id: string): Promise<UpstreamRecord<string, TState> | null>
  /**
   * Atomic read-modify-write of the `state` column. The updater sees the
   * current state coerced to `TState`; the return value replaces it. Backends
   * implement this in a single transaction so concurrent rotations don't
   * clobber each other. Throws `UpstreamGoneError` if no row exists for `id`.
   */
  saveState<TState>(id: string, updater: (current: TState) => TState): Promise<void>
}
