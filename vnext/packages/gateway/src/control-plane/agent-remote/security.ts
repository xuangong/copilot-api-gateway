import { __registerPlatformReset } from "@vibe-core/platform"

type SecurityAction = "launch" | "share" | "reauthentication" | "oauth"
type SecurityOutcome = "allowed" | "denied" | "rate_limited"

export function remoteSecurityEvent(action: SecurityAction, outcome: SecurityOutcome): void {
  console.info(JSON.stringify({ event: "agent_remote_security", action, outcome }))
}

export class RemoteRateWindow {
  private readonly entries = new Map<string, { count: number; until: number }>()
  constructor(private readonly maxEntries = 4096) {}

  allow(key: string, limit: number, now = Date.now()): boolean {
    for (const [id, entry] of this.entries) if (entry.until <= now) this.entries.delete(id)
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= this.maxEntries) return false
      entry = { count: 0, until: now + 60_000 }
      this.entries.set(key, entry)
    }
    if (entry.count >= limit) return false
    entry.count++
    return true
  }
}

let windows = new RemoteRateWindow()
__registerPlatformReset(() => { windows = new RemoteRateWindow() })

export function remoteRateAllowed(action: SecurityAction, key: string, limit: number): boolean {
  const allowed = windows.allow(`global:${action}`, 1200) && windows.allow(`${action}:${key}`, limit)
  if (!allowed) remoteSecurityEvent(action, "rate_limited")
  return allowed
}
