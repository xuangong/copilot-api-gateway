import { api } from "./client"

export interface InviteCode {
  id: string
  code: string
  name: string
  createdAt: string
  usedAt?: string | null
  usedBy?: string | null
}

export interface GithubAccountSummary {
  id: number
  login: string
  avatar_url?: string
  account_type?: string
}

export interface AdminUser {
  id: string
  name: string
  email?: string
  disabled?: boolean
  createdAt: string
  githubAccounts?: GithubAccountSummary[]
  keyCount: number
  sharedKeyCount: number
}

export interface CopilotQuotaSnap {
  unlimited?: boolean
  entitlement?: number
  remaining?: number
}
export interface CopilotQuotaResponse {
  quota_snapshots?: Record<string, CopilotQuotaSnap | undefined>
}

export interface KeyAssignmentInfo {
  id: string
  name: string
  assigned: boolean
}

interface RawApiKey {
  id: string
  name: string
  owner_id?: string | null
  is_owner?: boolean
}

interface RawKeyAssignment {
  key_id: string
  user_id: string
  user_name?: string | null
  assigned_by: string
  assigned_at: string
}

// === Invite codes ===
export function listInviteCodes(): Promise<InviteCode[]> {
  return api<InviteCode[]>("/auth/admin/invite-codes")
}
export function createInviteCode(name: string): Promise<InviteCode> {
  return api<InviteCode>("/auth/admin/invite-codes", { method: "POST", body: { name } })
}
export function deleteInviteCode(id: string): Promise<{ ok: true }> {
  return api(`/auth/admin/invite-codes/${encodeURIComponent(id)}`, { method: "DELETE" })
}

// === Users ===
export function listAdminUsers(): Promise<AdminUser[]> {
  return api<AdminUser[]>("/auth/admin/users")
}
export function setUserDisabled(id: string, disabled: boolean): Promise<{ ok: true }> {
  const action = disabled ? "disable" : "enable"
  return api(`/auth/admin/users/${encodeURIComponent(id)}/${action}`, { method: "POST" })
}
export function deleteAdminUser(id: string): Promise<{ ok: true }> {
  return api(`/auth/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" })
}

// === Copilot quota for a GitHub account ===
export function getCopilotQuota(githubUserId: number): Promise<CopilotQuotaResponse> {
  return api<CopilotQuotaResponse>(`/api/admin/copilot-quota/${encodeURIComponent(String(githubUserId))}`)
}

// === Key assignments ===
export async function loadAssignableKeys(targetUserId: string): Promise<KeyAssignmentInfo[]> {
  const allKeys = await api<RawApiKey[]>("/api/keys")
  // Match legacy: keys the caller owns (is_owner !== false), excluding ones already
  // owned by the target user.
  const keys = allKeys.filter((k) => k.is_owner !== false && k.owner_id !== targetUserId)
  const assignments = await Promise.all(
    keys.map((k) =>
      api<RawKeyAssignment[]>(`/api/keys/${encodeURIComponent(k.id)}/assignments`).catch((): RawKeyAssignment[] => []),
    ),
  )
  return keys.map((k, i) => ({
    id: k.id,
    name: k.name,
    assigned: (assignments[i] ?? []).some((a) => a.user_id === targetUserId),
  }))
}

export function assignKeyToUser(keyId: string, userId: string): Promise<{ ok: true }> {
  return api(`/api/keys/${encodeURIComponent(keyId)}/assign`, { method: "POST", body: { user_id: userId } })
}
export function unassignKeyFromUser(keyId: string, userId: string): Promise<{ ok: true }> {
  return api(`/api/keys/${encodeURIComponent(keyId)}/assign/${encodeURIComponent(userId)}`, { method: "DELETE" })
}

// === Helpers ===
export function formatQuotaChip(q?: { loading?: boolean; error?: string; data?: CopilotQuotaResponse | null }): string {
  if (!q) return "…"
  if (q.loading) return "…"
  if (q.error) return "!"
  const snaps = q.data?.quota_snapshots
  if (!snaps) return "—"
  const snap: CopilotQuotaSnap | undefined =
    snaps.premium_interactions ??
    snaps.chat ??
    snaps.completions ??
    (Object.values(snaps).find((s) => s && (s.unlimited || typeof s.entitlement === "number")) as CopilotQuotaSnap | undefined)
  if (!snap) return "—"
  if (snap.unlimited) return "∞"
  const used = (snap.entitlement ?? 0) - (snap.remaining ?? 0)
  return `${used}/${snap.entitlement ?? 0}`
}

export function timeAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ""
  const diff = Math.max(0, Date.now() - t)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 30) return `${days}d ago`
  const mo = Math.floor(days / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}
