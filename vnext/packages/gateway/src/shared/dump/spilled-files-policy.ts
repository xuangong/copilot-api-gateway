// Shared constants for the request-dump storage layer.
//
// DUMP_FILE_PREFIX: all dump body files land under this prefix in the
//   FileProvider so ops tooling can distinguish them from other spilled data.
// SPILLED_FILE_STAGE_GRACE_MS: how long a staged spilled_files row remains
//   collectible if its owning dump_records row never lands (e.g. crash
//   between file put and row insert). One hour matches the reference impl.
export const DUMP_FILE_PREFIX = "dumps/v1/"
export const SPILLED_FILE_STAGE_GRACE_MS = 60 * 60 * 1000
