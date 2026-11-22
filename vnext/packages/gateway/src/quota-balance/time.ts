// packages/gateway/src/quota-balance/time.ts
export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000

export const monthStartMs = (nowMs: number): number => { const d = new Date(nowMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) }
/** The next 00:00 UTC on the 1st: when every allowance resets. */
export const nextMonthStartMs = (nowMs: number): number => { const d = new Date(nowMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) }
export const monthKey = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 7)
export const hoursLeftInMonth = (nowMs: number): number => (nextMonthStartMs(nowMs) - nowMs) / HOUR_MS
