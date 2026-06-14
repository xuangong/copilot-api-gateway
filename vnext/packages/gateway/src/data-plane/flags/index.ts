export {
  OPTIONAL_FLAGS,
  getFlagCatalog,
  isKnownFlagId,
  defaultsForUpstream,
  parseFlagOverridesWire,
  type Flag,
  type OptionalFlagId,
} from "./catalog"

export {
  resolveEffectiveFlags,
  hasExplicitOverride,
  type FlagOverrides,
} from "./resolve"
