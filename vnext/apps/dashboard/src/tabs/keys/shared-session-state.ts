export function generateSharedSessionSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join("")
}

export function sharedSessionDraft(enabled: boolean, configured: boolean, draft: string): { enabled: boolean; secret?: string } | null {
  if (!enabled) return { enabled: false }
  const secret = draft.trim().toLowerCase()
  if (secret && !/^[0-9a-f]{64}$/.test(secret)) return null
  if (enabled && !configured && !secret) return null
  return { enabled, ...(secret ? { secret } : {}) }
}
