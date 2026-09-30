import { useState } from "react"
import type { DumpBody } from "../../api/dumps"
import { useDumps } from "../../state/dumps"
import { useT } from "../../state/i18n"

function BodyView({ body }: { body: DumpBody }) {
  const [showBinary, setShowBinary] = useState(false)
  const t = useT()
  if (body.encoding === "utf8") return <pre className="whitespace-pre-wrap break-all text-xs">{body.data}</pre>
  const byteLength = Math.max(0, Math.floor(body.data.length * 3 / 4) - (body.data.endsWith("==") ? 2 : body.data.endsWith("=") ? 1 : 0))
  return (
    <div className="text-xs text-themed-dim">
      <p>{t("dash.requests.binary", { bytes: byteLength })}</p>
      <button type="button" className="btn-secondary mt-2" onClick={() => setShowBinary((value) => !value)}>
        {showBinary ? t("dash.requests.hideBase64") : t("dash.requests.showBase64")}
      </button>
      {showBinary ? <pre className="mt-2 whitespace-pre-wrap break-all">{body.data}</pre> : null}
    </div>
  )
}

export function RequestsPanel({ keyId, keyName, onClose }: { keyId: string; keyName: string; onClose: () => void }) {
  const dumps = useDumps(keyId)
  const t = useT()
  return (
    <section className="glass-card p-4 sm:p-6 mb-8 animate-in" aria-label={t("dash.requests.title", { name: keyName })}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-themed font-medium">{t("dash.requests.title", { name: keyName })}</h3>
          <p className="text-xs text-themed-dim mt-1">{t("dash.requests.scope")}</p>
        </div>
        <button type="button" className="btn-secondary text-xs" onClick={onClose}>{t("dash.requests.close")}</button>
      </div>
      {dumps.listError ? <p role="alert" className="text-accent-red text-sm mb-3">{dumps.listError}</p> : null}
      {dumps.liveError ? <p role="status" className="text-accent-red text-sm mb-3">{dumps.liveError}</p> : null}
      {dumps.loading && dumps.records.length === 0 ? <p className="text-sm text-themed-dim">{t("dash.requests.loading")}</p> : null}
      {!dumps.loading && !dumps.listError && dumps.records.length === 0 ? <p className="text-sm text-themed-dim">{t("dash.requests.empty")}</p> : null}
      <div className="space-y-2">
        {dumps.records.map((record) => (
          <button
            key={record.id}
            type="button"
            onClick={() => void dumps.openDetail(record.id)}
            aria-expanded={dumps.selectedId === record.id}
            className="w-full text-left rounded-lg bg-surface-800/60 px-3 py-2 hover:bg-surface-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-violet"
          >
            <span className="font-mono text-xs text-themed">{record.id}</span>
            <span className="ml-3 text-xs text-themed-secondary">{record.method} · {record.status ?? "—"} · {record.durationMs} ms</span>
            <span className="block text-xs text-themed-dim break-all mt-1">{record.path}</span>
            {record.capture?.state === "omitted" ? <span className="block text-xs text-accent-red mt-1">{t("dash.requests.captureOmitted")}</span> : null}
          </button>
        ))}
      </div>
      {dumps.hasMore ? (
        <button type="button" className="btn-secondary text-xs mt-3" disabled={dumps.loadingMore} onClick={dumps.loadMore}>
          {dumps.loadingMore ? t("dash.requests.loadingMore") : t("dash.requests.older")}
        </button>
      ) : null}
      {dumps.selectedId ? (
        <div className="border-t border-white/10 mt-5 pt-5">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-themed text-sm font-medium">{t("dash.requests.record", { id: dumps.selectedId })}</h4>
            <button type="button" className="btn-secondary text-xs" disabled={dumps.downloading} onClick={() => void dumps.download()}>
              {dumps.downloading ? t("dash.requests.downloading") : t("dash.requests.download")}
            </button>
          </div>
          {dumps.detailLoading ? <p className="text-sm text-themed-dim mt-2">{t("dash.requests.loadingDetail")}</p> : null}
          {dumps.detailError ? <p role="alert" className="text-accent-red text-sm mt-2">{dumps.detailError}</p> : null}
          {dumps.detail?.meta.capture?.state === "omitted" ? (
            <p role="status" className="text-accent-red text-sm mt-3">
              {t("dash.requests.captureOmittedDetail")} {t(`dash.requests.captureReason.${dumps.detail.meta.capture.reason}`)}
            </p>
          ) : null}
          {dumps.detail ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4 text-themed-secondary">
              <section className="min-w-0">
                <h5 className="text-themed text-sm font-medium mb-2">{t("dash.requests.rawClient")}</h5>
                <p className="text-xs break-all mb-2">{dumps.detail.request.method} {dumps.detail.request.path}</p>
                <pre className="text-xs whitespace-pre-wrap break-all mb-3">{dumps.detail.request.headers.map(([name, value]) => `${name}: ${value}`).join("\n")}</pre>
                <BodyView body={dumps.detail.request.body} />
              </section>
              <section className="min-w-0">
                <h5 className="text-themed text-sm font-medium mb-2">{t("dash.requests.canonicalOutput")}</h5>
                <p className="text-xs mb-2">{t("dash.requests.status", { status: dumps.detail.response.status ?? "—" })}</p>
                <pre className="text-xs whitespace-pre-wrap break-all mb-3">{dumps.detail.response.headers.map(([name, value]) => `${name}: ${value}`).join("\n")}</pre>
                {dumps.detail.response.body.type === "none" && !dumps.detail.meta.capture ? <p className="text-xs text-themed-dim">{t("dash.requests.noBody")}</p> : null}
                {dumps.detail.response.body.type === "bytes" ? <BodyView body={dumps.detail.response.body.body} /> : null}
                {dumps.detail.response.body.type === "stream" ? (
                  <pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(dumps.detail.response.body.events, null, 2)}</pre>
                ) : null}
              </section>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
