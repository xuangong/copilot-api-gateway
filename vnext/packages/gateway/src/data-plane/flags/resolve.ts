/**
 * Tri-state flag resolver.
 *
 * Each layer is `Record<flagId, boolean>`:
 *   - absent key  → inherit from previous layer
 *   - true        → force-on at this layer
 *   - false       → force-off at this layer (including flags seeded by
 *                   provider defaults — admins explicitly opted out)
 *
 * Layer order matters: later layers override earlier ones. Typical chain:
 *   providerDefaults  → upstream.flagOverrides  → deployment.flagOverrides
 */

export type FlagOverrides = Record<string, boolean>

export function resolveEffectiveFlags(
  providerDefaults: ReadonlySet<string>,
  layers: readonly (FlagOverrides | undefined)[],
): ReadonlySet<string> {
  const effective = new Set<string>(providerDefaults)
  for (const layer of layers) {
    if (!layer) continue
    for (const [id, on] of Object.entries(layer)) {
      if (on) effective.add(id)
      else effective.delete(id)
    }
  }
  return effective
}

/**
 * Convenience: did any layer explicitly toggle this flag (vs inheriting)?
 * Useful for dashboard "diff from defaults" rendering.
 */
export function hasExplicitOverride(
  flagId: string,
  layers: readonly (FlagOverrides | undefined)[],
): boolean {
  for (const layer of layers) {
    if (layer && Object.prototype.hasOwnProperty.call(layer, flagId)) return true
  }
  return false
}
