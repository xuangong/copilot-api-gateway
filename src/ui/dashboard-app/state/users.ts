import { useCallback, useEffect, useState } from "react"
import { useToast } from "./toast"
import * as api from "../api/users"

export interface QuotaState {
  loading: boolean
  error?: string
  data?: api.CopilotQuotaResponse | null
}

export function useUsers() {
  const { push: toast } = useToast()
  const [users, setUsers] = useState<api.AdminUser[]>([])
  const [usersLoading, setUsersLoading] = useState(true)
  const [invites, setInvites] = useState<api.InviteCode[]>([])
  const [invitesLoading, setInvitesLoading] = useState(true)
  const [inviteCreating, setInviteCreating] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [quotas, setQuotas] = useState<Record<number, QuotaState>>({})

  const loadGithubQuota = useCallback(async (id: number) => {
    setQuotas((q) => ({ ...q, [id]: { loading: true } }))
    try {
      const data = await api.getCopilotQuota(id)
      setQuotas((q) => ({ ...q, [id]: { loading: false, data } }))
    } catch (e) {
      setQuotas((q) => ({ ...q, [id]: { loading: false, error: e instanceof Error ? e.message : String(e), data: null } }))
    }
  }, [])

  const reloadUsers = useCallback(async () => {
    setUsersLoading(true)
    try {
      const list = await api.listAdminUsers()
      setUsers(list)
      setQuotas({})
      for (const u of list) {
        for (const gh of u.githubAccounts ?? []) {
          if (gh?.id != null) loadGithubQuota(gh.id)
        }
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setUsersLoading(false)
    }
  }, [toast, loadGithubQuota])

  const reloadInvites = useCallback(async () => {
    setInvitesLoading(true)
    try {
      setInvites(await api.listInviteCodes())
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setInvitesLoading(false)
    }
  }, [toast])

  useEffect(() => {
    reloadUsers()
    reloadInvites()
  }, [reloadUsers, reloadInvites])

  const withBusy = async <T,>(id: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      return await fn()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
      return null
    } finally {
      setBusy((b) => {
        const { [id]: _drop, ...rest } = b
        return rest
      })
    }
  }

  const createInvite = async (name: string): Promise<boolean> => {
    const trimmed = name.trim()
    if (!trimmed) return false
    setInviteCreating(true)
    try {
      await api.createInviteCode(trimmed)
      await reloadInvites()
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
      return false
    } finally {
      setInviteCreating(false)
    }
  }

  const deleteInvite = async (id: string): Promise<void> => {
    if (!confirm("Delete this invite code?")) return
    await withBusy(`inv-${id}`, async () => {
      await api.deleteInviteCode(id)
      await reloadInvites()
    })
  }

  const toggleUser = (u: api.AdminUser) =>
    withBusy(u.id, async () => {
      await api.setUserDisabled(u.id, !u.disabled)
      await reloadUsers()
    })

  const deleteUser = async (u: api.AdminUser): Promise<void> => {
    if (!confirm(`Delete user "${u.name}"? This removes their keys, tokens, and assignments.`)) return
    await withBusy(u.id, async () => {
      await api.deleteAdminUser(u.id)
      toast(`Deleted ${u.name}`, "success")
      await reloadUsers()
    })
  }

  return {
    users,
    usersLoading,
    invites,
    invitesLoading,
    inviteCreating,
    busy,
    quotas,
    reloadUsers,
    reloadInvites,
    createInvite,
    deleteInvite,
    toggleUser,
    deleteUser,
  }
}
