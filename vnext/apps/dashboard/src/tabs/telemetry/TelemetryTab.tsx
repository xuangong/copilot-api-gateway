import { useState } from "react"
import type { TelemetrySource } from "../../api/telemetry"
import { useT } from "../../state/i18n"
import { PageHeader } from "../../ui/page-header"
import { SourceListSection } from "./SourceList"
import { SourcePage } from "./SourcePage"

/** The selected source is component state: the hash router has a single segment. */
export function TelemetryTab() {
  const t = useT()
  const [selected, setSelected] = useState<TelemetrySource | null>(null)
  if (selected) {
    // Keyed by id so an issued key and every panel state is dropped when another source is selected.
    return <SourcePage key={selected.id} source={selected} onBack={() => setSelected(null)} onSourceChanged={setSelected} onDeleted={() => setSelected(null)} />
  }
  return <div>
    <PageHeader title={t("dash.telemetry")} description={t("dash.telemetryDescription")} />
    <SourceListSection onOpen={setSelected} />
  </div>
}
