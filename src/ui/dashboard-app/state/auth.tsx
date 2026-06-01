import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { api, ApiError } from "../api/client"
import type { SessionInfo } from "../api/types"

interface AuthState {
  loading: boolean
  session: SessionInfo | null
  error: string | null
  logout: () => Promise<void>
}

const AuthCtx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api<SessionInfo>("/auth/login", { method: "POST", body: {} })
      .then((s) => {
        if (!cancelled) setSession(s)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 401) {
          window.location.href = "/"
          return
        }
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST" })
    } finally {
      window.location.href = "/"
    }
  }

  return <AuthCtx.Provider value={{ loading, session, error, logout }}>{children}</AuthCtx.Provider>
}

export function useAuth(): AuthState {
  const v = useContext(AuthCtx)
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>")
  return v
}
