import { api } from "./client"

export interface GroupSettings {
  toleranceShare: number
  softShare: number
  hardShare: number
  idleRebalanceMinutes: number
  migrateShare: number
  burnHorizonHours: number
  heavySessionUsdPerHour: number
  migrateMinHours: number
  exhaustedPolicy: "stop" | "overage"
  readIntervalHours: number
  confirmShare: number
  driftShare: number
  sessionIdleHours: number
}
export interface UpstreamGroup {
  id: string
  ownerId: string
  name: string
  enabled: boolean
  sortOrder: number
  settings: GroupSettings
  memberIds: string[]
  createdAt: string
  updatedAt: string
}
export type IneligibleReason = "group_disabled" | "disabled" | "cut_off" | "paused" | "no_read" | "soft_line"
export interface MemberStatus {
  upstreamId: string
  name: string
  login: string | null
  enabled: boolean
  unlimited: boolean
  usedShare: number | null
  entitlement: number | null
  estimatedUsed: number | null
  /** Null while unknown (no read yet, or no usable facts): shown as a dash, never as 0 %. */
  projectedShare: number | null
  lastRead: { at: number; source: "github" | "manual"; used: number; entitlement: number; share: number } | null
  k: number | null
  kPrevious: number | null
  kSamples: number
  outsideRate: number
  outsideShareLastDay: number | null
  lastErrorPoints: number | null
  intervalHours: number
  nextReadAt: number
  failures: number
  lastError: string | null
  /** Reads keep failing: the figures rest on a conservative gateway-only estimate or a stale read. */
  readFailing: boolean
  /** `never_read`: no successful read yet (not eligible); `stale`: reads keep failing on a cautious estimate. */
  readFailingReason?: "never_read" | "stale" | null
  entitlementChange: { from: number; to: number; at: number } | null
  cutOff: { until: number; provisional: boolean; share: number } | null
  eligibility: { eligible: boolean; reason: IneligibleReason | null }
  activeSessions: number
}
export interface GroupStatus {
  group: UpstreamGroup
  state: "normal" | "stopped" | "overage" | "unknown"
  members: MemberStatus[]
  attention: Array<{ upstreamId: string; kind: "large_error" | "read_failing" | "entitlement_changed" }>
  nowMs: number
}
export interface LiveGroupStatus extends GroupStatus { reads: Array<{ upstreamId: string; status: "read" | "reused" | "error" | "unsupported" }> }
export type GroupAlert =
  | { kind: "stopped" | "overage"; groupId: string; groupName: string }
  /** A member whose reads keep failing; only members the viewer may see are named. */
  | { kind: "read_failing"; reason?: "never_read" | "stale"; groupId: string; groupName: string; upstreamId: string; upstreamName: string }
export interface RefreshResult { status: "read" | "reused" | "error" | "unsupported"; lastReadAt?: number | null; blockedUntil?: number }
export interface GroupCreate { name: string; settings?: Partial<GroupSettings>; sortOrder?: number }
export interface GroupPatch { name?: string; enabled?: boolean; sortOrder?: number; settings?: Partial<GroupSettings> }
export interface Calibration { used?: number; entitlement?: number; usedShare?: number; at?: number }

const group = (id: string) => `/api/upstream-groups/${encodeURIComponent(id)}`
const quota = (upstreamId: string, rest: string) => `/api/upstreams/${encodeURIComponent(upstreamId)}/${rest}`

export const listGroups = () => api<{ groups: UpstreamGroup[] }>("/api/upstream-groups")
export const createGroup = (body: GroupCreate) => api<{ group: UpstreamGroup }>("/api/upstream-groups", { method: "POST", body })
export const patchGroup = (id: string, body: GroupPatch) => api<{ group: UpstreamGroup }>(group(id), { method: "PATCH", body })
export const deleteGroup = (id: string) => api<{ ok: true }>(group(id), { method: "DELETE" })
export const getGroupStatus = (id: string) => api<GroupStatus>(`${group(id)}/status`)
/** Page open: the server reads members not read in the last 10 minutes (reusing newer reads) and answers with the fresh status. */
export const liveGroup = (id: string) => api<LiveGroupStatus>(`${group(id)}/live`, { method: "POST" })
export const getGroupAlerts = () => api<{ alerts: GroupAlert[] }>("/api/upstream-groups/alerts")
export const setUpstreamGroup = (upstreamId: string, groupId: string | null) => api<{ ok: true; groupId: string | null }>(quota(upstreamId, "group"), { method: "PUT", body: { groupId } })
/** The server reads GitHub at most every 10 minutes per member and otherwise answers `reused`. */
export const refreshQuota = (upstreamId: string) => api<RefreshResult>(quota(upstreamId, "quota/refresh"), { method: "POST" })
export const calibrateQuota = (upstreamId: string, body: Calibration) => api<{ status: "read" }>(quota(upstreamId, "quota/calibrate"), { method: "POST", body })
