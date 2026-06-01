import { useCallback, useEffect, useState } from "react"
import { useToast } from "./toast"
import * as api from "../api/clients"
import type { RelayClient } from "../api/clients"

export function useClients() {
  const { push: toast } = useToast()
  const [clients, setClients] = useState<RelayClient[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await api.listRelays()
      setClients(rows)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    reload()
  }, [reload])

  return { clients, loading, reload }
}
