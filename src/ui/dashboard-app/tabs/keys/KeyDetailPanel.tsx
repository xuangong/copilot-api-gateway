import type { ApiKeyDetail, KeyPatchBody, WebSearchRange, WebSearchUsage } from "../../api/keys"
import type { QuotaUsage } from "../../state/keys"
import { AssigneesPanel, SharedByOwnerPanel } from "./AssigneesPanel"
import { ConfigurationPanel } from "./ConfigurationPanel"
import { QuotaEditor } from "./QuotaEditor"
import { WebSearchPanel } from "./WebSearchPanel"

interface Props {
  keyRow: ApiKeyDetail
  allKeys: ApiKeyDetail[]
  isAdmin: boolean
  isUser: boolean
  busy: boolean
  quotaUsage: QuotaUsage
  wsUsage: WebSearchUsage
  wsUsageRange: WebSearchRange
  onWsUsageRangeChange: (r: WebSearchRange) => void
  onPatch: (body: KeyPatchBody) => Promise<boolean>
  onCopyWebSearchFrom: (sourceId: string) => Promise<boolean>
  onAssign: (email: string) => Promise<boolean>
  onUnassign: (userId: string) => Promise<boolean>
}

export function KeyDetailPanel({
  keyRow,
  allKeys,
  isAdmin,
  isUser,
  busy,
  quotaUsage,
  wsUsage,
  wsUsageRange,
  onWsUsageRangeChange,
  onPatch,
  onCopyWebSearchFrom,
  onAssign,
  onUnassign,
}: Props) {
  const isOwned = keyRow.is_owner !== false
  const canManage = (isAdmin || isUser) && isOwned

  return (
    <>
      {isOwned ? (
        <AssigneesPanel keyRow={keyRow} onAssign={onAssign} onUnassign={onUnassign} />
      ) : (
        <SharedByOwnerPanel keyRow={keyRow} />
      )}

      <QuotaEditor
        keyRow={keyRow}
        usage={quotaUsage}
        canEdit={canManage}
        busy={busy}
        onSave={async (req, token) =>
          onPatch({ quota_requests_per_day: req, quota_tokens_per_day: token })
        }
      />

      <WebSearchPanel
        keyRow={keyRow}
        allKeys={allKeys}
        isAdmin={isAdmin}
        canEdit={canManage}
        busy={busy}
        usage={wsUsage}
        usageRange={wsUsageRange}
        onUsageRangeChange={onWsUsageRangeChange}
        onSave={onPatch}
        onCopyFrom={onCopyWebSearchFrom}
      />

      <ConfigurationPanel keyRow={keyRow} />
    </>
  )
}
