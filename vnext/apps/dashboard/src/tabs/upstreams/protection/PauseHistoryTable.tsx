// apps/dashboard/src/tabs/upstreams/protection/PauseHistoryTable.tsx
import { summarizeReason } from "../../../components/protection-banner-model"
import type { ProtectionPause } from "../../../api/protection"
import { useT } from "../../../state/i18n"
import { Badge } from "../../../ui/badge"
import { Table, TBody, Td, Th } from "../../../ui/table"
import { formatInstantMs } from "../../telemetry/telemetry-format"

/** Newest first: target, reason summary, start, end (the scheduled end while active) and how it ended. */
export function PauseHistoryTable({ pauses }: { pauses: readonly ProtectionPause[] }) {
  const t = useT()
  if (pauses.length === 0) return <p className="text-body text-fg-subtle">{t("dash.protHistoryEmpty")}</p>
  const how = (pause: ProtectionPause) => pause.endedBy === "owner" ? t("dash.protEndedOwner") : pause.endedBy === "auto" ? t("dash.protEndedAuto") : t("dash.protEndedActive")
  return (
    <Table label={t("dash.protHistoryTitle")}>
      <thead>
        <tr>
          <Th>{t("dash.protColTarget")}</Th><Th>{t("dash.protColReason")}</Th><Th>{t("dash.protColStarted")}</Th><Th>{t("dash.protColEnded")}</Th><Th>{t("dash.protColHow")}</Th>
        </tr>
      </thead>
      <TBody>
        {pauses.map((pause) => (
          <tr key={pause.id}>
            <Td>
              <div className="flex flex-wrap items-center gap-1">
                <Badge tone={pause.mode === "pause" ? "danger" : "warn"}>{pause.mode === "pause" ? t("dash.protRowPause") : t("dash.protRowWarning")}</Badge>
                <span className="text-fg-muted">{pause.targetKind === "key" ? t("dash.protTargetKey") : t("dash.protTargetUpstream")}</span>
                <span className="font-medium">{pause.targetName}</span>
              </div>
            </Td>
            <Td>{summarizeReason(pause.reason, t)}</Td>
            <Td className="whitespace-nowrap tabular-nums">{formatInstantMs(pause.startedAt)}</Td>
            <Td className="whitespace-nowrap tabular-nums">{formatInstantMs(pause.endedBy === "owner" && pause.resolvedAt !== null ? pause.resolvedAt : pause.endsAt)}</Td>
            <Td>{how(pause)}</Td>
          </tr>
        ))}
      </TBody>
    </Table>
  )
}
