import { useEffect, useState } from "react"

// Thin wrapper over the global window.t() injected by renderI18nScript().
// Provides a useT() hook that re-renders components when the user toggles
// the language (toggleLang() reloads the page, but we also re-render in case
// future toggleLang() implementations stop reloading).

declare global {
  interface Window {
    t?: (key: string, vars?: Record<string, string | number>) => string
    __lang?: "en" | "zh"
    toggleLang?: () => void
  }
}

function lookup(key: string, vars?: Record<string, string | number>): string {
  if (typeof window === "undefined" || !window.t) return key
  try {
    return window.t(key, vars)
  } catch {
    return key
  }
}

export function t(key: string, vars?: Record<string, string | number>): string {
  return lookup(key, vars)
}

/** Dates follow the interface language, not the browser's: "Aug 12" or "8月12日". */
export function dateLocale(): "en-US" | "zh-CN" {
  return typeof window !== "undefined" && window.__lang === "zh" ? "zh-CN" : "en-US"
}

export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const [, setTick] = useState(0)
  useEffect(() => {
    const handler = () => setTick((n) => n + 1)
    window.addEventListener("lang-changed", handler)
    return () => window.removeEventListener("lang-changed", handler)
  }, [])
  return lookup
}
