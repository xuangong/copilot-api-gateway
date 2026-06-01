import type { JustCreatedKey } from "../../state/keys"
import { useT } from "../../state/i18n"
import { copyToClipboard } from "./helpers"

interface Props {
  data: JustCreatedKey
  onClose: () => void
}

export function JustCreatedKeyModal({ data, onClose }: Props) {
  const t = useT()
  const curl = `curl ${data.baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${data.key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'`

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="glass-card p-4 sm:p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto glow-primary">
        <h3 className="text-themed font-semibold mb-2">{t("dash.keyCreatedTitle")}</h3>
        <p className="text-xs text-themed-dim mb-4">
          {t("dash.keyCreatedDesc")}
        </p>

        <div className="bg-surface-900 rounded-lg p-3 mb-4 font-mono text-xs flex items-center justify-between gap-2">
          <span className="text-themed truncate">{data.key}</span>
          <button
            type="button"
            onClick={() => copyToClipboard(data.key)}
            className="btn-ghost text-xs px-2 py-1 shrink-0"
          >
            {t("dash.copy")}
          </button>
        </div>

        <h4 className="text-xs font-medium text-themed-dim uppercase tracking-widest mb-2">
          {t("dash.quickTestCurl")}
        </h4>
        <div className="bg-surface-900 rounded-lg p-3 mb-4 font-mono text-[11px] overflow-x-auto">
          <pre className="text-themed-secondary whitespace-pre">{curl}</pre>
        </div>

        <p className="text-xs text-themed-dim mb-4">
          {t("dash.nextStepHint")}
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => copyToClipboard(`Authorization: Bearer ${data.key}`)}
            className="btn-ghost text-sm"
          >
            {t("dash.copyHeaderBtn")}
          </button>
          <button type="button" onClick={onClose} className="btn-primary text-sm">
            {t("dash.doneBtn")}
          </button>
        </div>
      </div>
    </div>
  )
}
