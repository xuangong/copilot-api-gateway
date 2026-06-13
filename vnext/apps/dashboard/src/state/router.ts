import { useEffect, useState } from "react"

// Minimal hash router. URL is `#<tab>` (or empty for default).
// Returns the current tab id and a setter that also updates the URL.

export function useHashTab(defaultTab: string, allowed: ReadonlyArray<string>) {
  const read = () => {
    const h = window.location.hash.replace(/^#/, "")
    return allowed.includes(h) ? h : defaultTab
  }
  const [tab, setTabState] = useState(read)

  useEffect(() => {
    setTabState(read())
    const onChange = () => setTabState(read())
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultTab, allowed.join(",")])

  const setTab = (next: string) => {
    if (!allowed.includes(next)) return
    if (window.location.hash !== `#${next}`) window.location.hash = next
    setTabState(next)
  }

  return [tab, setTab] as const
}
