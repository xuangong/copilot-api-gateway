// apps/dashboard/src/tabs/upstreams/protection/ErrorSamplesTable.tsx
import type { ErrorSample } from "../../../api/protection"
import { useT } from "../../../state/i18n"
import { Table, TBody, Td, Th } from "../../../ui/table"
import { formatInstantMs } from "../../telemetry/telemetry-format"

/** Latest samples per status, newest first within a status. React escapes the upstream's message: it is shown as text. */
export function ErrorSamplesTable({ samples }: { samples: readonly ErrorSample[] }) {
  const t = useT()
  if (samples.length === 0) return <p className="text-body text-fg-subtle">{t("dash.protSamplesEmpty")}</p>
  return (
    <Table label={t("dash.protSamplesTitle")}>
      <thead>
        <tr>
          <Th>{t("dash.protColStatus")}</Th><Th>{t("dash.protColCode")}</Th><Th>{t("dash.protColMessage")}</Th>
          <Th>{t("dash.protColTime")}</Th><Th>{t("dash.protColKey")}</Th><Th>{t("dash.protColModel")}</Th>
        </tr>
      </thead>
      <TBody>
        {samples.map((sample, index) => (
          <tr key={`${sample.status}-${sample.at}-${index}`}>
            <Td className="tabular-nums">{sample.status === 0 ? t("dash.protNetwork") : sample.status}</Td>
            <Td className="font-mono text-xs">{sample.code}</Td>
            <Td className="max-w-md break-words">{sample.message}</Td>
            <Td className="whitespace-nowrap tabular-nums">{formatInstantMs(sample.at)}</Td>
            <Td className="font-mono text-xs"><span title={sample.keyId}>{sample.keyId === "" ? "—" : sample.keyId.slice(0, 8)}</span></Td>
            <Td className="font-mono text-xs">{sample.model}</Td>
          </tr>
        ))}
      </TBody>
    </Table>
  )
}
