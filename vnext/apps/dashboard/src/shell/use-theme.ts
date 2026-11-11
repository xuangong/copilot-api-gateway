import { useSyncExternalStore } from "react"

declare global {
  interface Window {
    toggleTheme?: () => void
  }
}

type Theme = "light" | "dark"

// page.ts owns the theme: it sets <html data-theme>, persists it and fires
// "theme-changed". This only reads it back and asks page.ts to flip it.
function subscribe(onChange: () => void): () => void {
  window.addEventListener("theme-changed", onChange)
  return () => window.removeEventListener("theme-changed", onChange)
}

function getSnapshot(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"
}

function getServerSnapshot(): Theme {
  return "dark"
}

function toggle(): void {
  window.toggleTheme?.()
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return { theme, toggle }
}
