export function retentionFromDraft(enabled: boolean, days: string): number | null {
  if (!enabled) return 0
  const value = Number(days)
  return Number.isSafeInteger(value) && value >= 1 && value <= 3650 ? value * 86400 : null
}
