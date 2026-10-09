import type { ApiKeyDetail, KeyPatchBody, WebSearchRange, WebSearchUsage } from "../../api/keys"
import type { QuotaLoad, QuotaUsage } from "../../state/key-quota"
import { useModelCatalog } from "../../state/models"
import { AssigneesPanel, SharedByOwnerPanel } from "./AssigneesPanel"
import { ConfigurationPanel } from "./ConfigurationPanel"
import { SharedSessionPanel } from "./SharedSessionPanel"
import { ResponsesRetentionPanel } from "./ResponsesRetentionPanel"
import { QuotaEditor } from "./QuotaEditor"
import { WebSearchPanel } from "./WebSearchPanel"
import { ModelMappingsPanel } from "./ModelMappingsPanel"
import { UpstreamAccessPanel } from "./UpstreamAccessPanel"

interface Props {
  keyRow: ApiKeyDetail
  allKeys: ApiKeyDetail[]
  isAdmin: boolean
  isUser: boolean
  busy: boolean
  quotaUsage: QuotaUsage | null
  quotaLoad: QuotaLoad
  onSettingsSaved: () => Promise<void>
  onQuotaRetry: () => void
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
  quotaLoad,
  onSettingsSaved,
  onQuotaRetry,
  wsUsage,
  wsUsageRange,
  onWsUsageRangeChange,
  onPatch,
  onCopyWebSearchFrom,
  onAssign,
  onUnassign,
}: Props) {
  const modelCatalogState = useModelCatalog(keyRow.id)
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
        load={quotaLoad}
        onRetry={onQuotaRetry}
        canEdit={canManage}
        busy={busy}
        onSave={async (req, token, cost) =>
          onPatch({
            quota_requests_per_month: req,
            quota_tokens_per_month: token,
            quota_cost_per_month: cost,
          })
        }
      />

      <SharedSessionPanel key={keyRow.id} keyRow={keyRow} canEdit={canManage} busy={busy} onSaved={onSettingsSaved} />

      <ResponsesRetentionPanel key={keyRow.id} keyRow={keyRow} canEdit={canManage} busy={busy} onSave={onPatch} />

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
        catalog={modelCatalogState.catalog}
      />

      <UpstreamAccessPanel
        key={keyRow.id}
        keyRow={keyRow}
        canEdit={keyRow.can_manage_upstreams}
        busy={busy}
        onSave={async (body) => {
          const saved = await onPatch(body)
          if (saved) await modelCatalogState.refresh()
          return saved
        }}
      />

      <ModelMappingsPanel
        keyRow={keyRow}
        canEdit={keyRow.can_manage_model_mappings}
        busy={busy}
        catalog={modelCatalogState.catalog}
        catalogLoading={modelCatalogState.loading}
        onSave={async (body) => {
          const saved = await onPatch(body)
          if (saved) await modelCatalogState.refresh()
          return saved
        }}
      />

      <ConfigurationPanel
        key={keyRow.id}
        keyRow={keyRow}
        catalog={modelCatalogState.catalog}
        catalogLoading={modelCatalogState.loading}
      />
    </>
  )
}
