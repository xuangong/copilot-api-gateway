import { useId, useState } from "react"
import type { DumpBody } from "../../api/dumps"
import type { DumpLiveView } from "../../state/dump-live-session"
import { useDumps } from "../../state/dumps"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { cn } from "../../ui/cn"
import { Notice } from "../../ui/notice"

const CODE = "font-mono text-xs bg-muted border border-border rounded-md px-3 py-2 text-fg whitespace-pre-wrap break-all"

function BodyView({ body }: { body: DumpBody }) {
  const [showBinary, setShowBinary] = useState(false)
  const t = useT()
  if (body.encoding === "utf8") return <pre className={CODE}>{body.data}</pre>
  const byteLength = Math.max(0, Math.floor(body.data.length * 3 / 4) - (body.data.endsWith("==") ? 2 : body.data.endsWith("=") ? 1 : 0))
  return (
    <div className="text-xs text-fg-muted">
      <p className="tabular-nums">{t("dash.requests.binary", { bytes: byteLength })}</p>
      <Button variant="secondary" size="sm" className="mt-2" onClick={() => setShowBinary((value) => !value)}>
        {showBinary ? t("dash.requests.hideBase64") : t("dash.requests.showBase64")}
      </Button>
      {showBinary ? <pre className={cn(CODE, "mt-2")}>{body.data}</pre> : null}
    </div>
  )
}

export function RequestsLiveStatus({ continuity, omittedRows, loading, onRefresh }: {
  continuity: DumpLiveView["continuity"]; omittedRows: number; loading: boolean; onRefresh: () => void,
}) {
  const t = useT()
  return (
    <div className="mb-3 text-xs text-fg-muted">
      <p>{t("dash.requests.liveScope")}</p>
      {continuity ? <p role="status" className="mt-1">{t(`dash.requests.continuity.${continuity}`)}</p> : null}
      {omittedRows > 0 ? <p role="status" className="mt-1 tabular-nums">{t("dash.requests.liveOmitted", { count: omittedRows })}</p> : null}
      <Button variant="secondary" size="sm" className="mt-2" disabled={loading} onClick={onRefresh}>
        {t("dash.requests.refreshLatest")}
      </Button>
    </div>
  )
}

export function RequestsEmptyState({ loading, listError, recordCount, omittedRows }: {
  loading: boolean; listError: string | null; recordCount: number; omittedRows: number,
}) {
  const t = useT()
  return !loading && !listError && recordCount === 0 && omittedRows === 0 ? <p className="text-sm text-fg-muted">{t("dash.requests.empty")}</p> : null
}

export function RequestsPanel({ keyId, keyName, onClose }: { keyId: string; keyName: string; onClose: () => void }) {
  const dumps = useDumps(keyId)
  const t = useT()
  const panelId = useId()
  return (
    <Card className="mb-4" aria-labelledby={`${panelId}-title`}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <SectionHeading id={`${panelId}-title`}>{t("dash.requests.title", { name: keyName })}</SectionHeading>
          <p className="mt-1 text-xs text-fg-muted">{t("dash.requests.scope")}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onClose}>{t("dash.requests.close")}</Button>
      </div>
      <RequestsLiveStatus continuity={dumps.continuity} omittedRows={dumps.omittedRows} loading={dumps.loading} onRefresh={dumps.refreshLatest} />
      {dumps.listError ? <Notice tone="danger" className="mb-3">{dumps.listError}</Notice> : null}
      {dumps.liveError ? <Notice tone="warn" role="status" className="mb-3">{dumps.liveError}</Notice> : null}
      {dumps.loading && dumps.records.length === 0 ? <p className="text-sm text-fg-muted">{t("dash.requests.loading")}</p> : null}
      <RequestsEmptyState loading={dumps.loading} listError={dumps.listError} recordCount={dumps.records.length} omittedRows={dumps.omittedRows} />
      <div className="space-y-2">
        {dumps.records.map((record) => {
          const expanded = dumps.selectedId === record.id
          return (
            <button
              key={record.id}
              type="button"
              onClick={() => void dumps.openDetail(record.id)}
              aria-expanded={expanded}
              className={cn(
                "w-full cursor-pointer rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
                expanded && "bg-muted",
              )}
            >
              <span className="font-mono text-xs text-fg">{record.id}</span>
              <span className="ml-3 text-xs text-fg-muted tabular-nums">{record.method} · {record.status ?? "—"} · {record.durationMs} ms</span>
              <span className="mt-1 block break-all text-xs text-fg-subtle">{record.path}</span>
              {record.capture?.state === "omitted" ? <span className="mt-1 block text-xs text-danger">{t("dash.requests.captureOmitted")}</span> : null}
            </button>
          )
        })}
      </div>
      {dumps.hasMore ? (
        <Button variant="secondary" size="sm" className="mt-3" disabled={dumps.loadingMore} onClick={dumps.loadMore}>
          {dumps.loadingMore ? t("dash.requests.loadingMore") : t("dash.requests.older")}
        </Button>
      ) : null}
      {dumps.selectedId ? (
        <div className="mt-5 border-t border-border pt-5">
          <div className="flex items-center justify-between gap-3">
            <SectionHeading as="h3">{t("dash.requests.record", { id: dumps.selectedId })}</SectionHeading>
            <Button variant="secondary" size="sm" disabled={dumps.downloading} onClick={() => void dumps.download()}>
              {dumps.downloading ? t("dash.requests.downloading") : t("dash.requests.download")}
            </Button>
          </div>
          {dumps.detailLoading ? <p className="mt-2 text-sm text-fg-muted">{t("dash.requests.loadingDetail")}</p> : null}
          {dumps.detailError ? <Notice tone="danger" className="mt-2">{dumps.detailError}</Notice> : null}
          {dumps.detail?.meta.capture?.state === "omitted" ? (
            <Notice tone="danger" role="status" className="mt-3">
              {t("dash.requests.captureOmittedDetail")} {t(`dash.requests.captureReason.${dumps.detail.meta.capture.reason}`)}
            </Notice>
          ) : null}
          {dumps.detail ? (
            <div className="mt-4 grid grid-cols-1 gap-4 text-fg-muted lg:grid-cols-2">
              <section className="min-w-0">
                <h4 className="mb-2 text-[13px] font-medium text-fg">{t("dash.requests.rawClient")}</h4>
                <p className="mb-2 break-all font-mono text-xs">{dumps.detail.request.method} {dumps.detail.request.path}</p>
                <pre className={cn(CODE, "mb-3")}>{dumps.detail.request.headers.map(([name, value]) => `${name}: ${value}`).join("\n")}</pre>
                <BodyView body={dumps.detail.request.body} />
              </section>
              <section className="min-w-0">
                <h4 className="mb-2 text-[13px] font-medium text-fg">{t("dash.requests.canonicalOutput")}</h4>
                <p className="mb-2 text-xs tabular-nums">{t("dash.requests.status", { status: dumps.detail.response.status ?? "—" })}</p>
                <pre className={cn(CODE, "mb-3")}>{dumps.detail.response.headers.map(([name, value]) => `${name}: ${value}`).join("\n")}</pre>
                {dumps.detail.response.body.type === "none" && !dumps.detail.meta.capture ? <p className="text-xs text-fg-subtle">{t("dash.requests.noBody")}</p> : null}
                {dumps.detail.response.body.type === "bytes" ? <BodyView body={dumps.detail.response.body.body} /> : null}
                {dumps.detail.response.body.type === "stream" ? (
                  <pre className={CODE}>{JSON.stringify(dumps.detail.response.body.events, null, 2)}</pre>
                ) : null}
              </section>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
