// Shared exponential backoff schedule for proxy dial failures.
//
// Both the SQL UPSERT and any in-memory mirror need to agree on the geometric
// progression 60·2^(n-1) clamped at 3600s. Keep the two constants side by side
// so the SQL literal (below) and the JS mirror (should one appear) can't
// drift.

/** Baseline dwell time in seconds after the first failure. */
export const BACKOFF_BASE_SECONDS = 60

/** Hard cap on the schedule so a chronically-broken proxy retries hourly. */
export const BACKOFF_MAX_SECONDS = 3600

/**
 * Cap on the exponent used inside SQLite's `1 << n`. Anything past 6 already
 * saturates against BACKOFF_MAX_SECONDS; capping keeps the shift bounded
 * regardless of how long a runaway proxy has been failing.
 */
export const BACKOFF_MAX_EXPONENT = 6
