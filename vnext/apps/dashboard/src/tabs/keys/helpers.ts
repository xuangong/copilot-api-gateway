// Small format helpers shared by the keys tab.

export function truncateKey(key: string | null | undefined): string {
  if (!key) return ""
  if (key.length <= 12) return key
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

export function timeAgo(dateStr: string | null | undefined, nowMs: number = Date.now()): string {
  if (!dateStr) return ""
  const date = new Date(dateStr)
  const diff = nowMs - date.getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days <= 30) return `${days}d ago`
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function fullDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return ""
  const d = new Date(dateStr)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Copies text and reports whether it worked. Falls back to execCommand when the
 * async clipboard API is missing or blocked (e.g. plain HTTP on a LAN address).
 * The fallback textarea goes inside the open dialog, if any: a modal dialog traps
 * focus, and selecting text outside it would be undone before the copy runs.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through */
  }
  try {
    const host = document.activeElement?.closest('[role="dialog"]') ?? document.body
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    host.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    host.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export const DEFAULT_WS_PRIORITY = ["msGrounding", "langsearch", "tavily", "jina", "bing", "copilot"] as const
export type WsEngineId = (typeof DEFAULT_WS_PRIORITY)[number]
