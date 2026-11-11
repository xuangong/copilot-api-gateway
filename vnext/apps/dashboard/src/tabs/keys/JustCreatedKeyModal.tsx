import { type RefObject, useEffect, useRef, useState } from "react"
import { Check } from "lucide-react"
import type { JustCreatedKey } from "../../state/keys"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import { Button } from "../../ui/button"
import { CodeBlock } from "../../ui/code-block"
import { Dialog } from "../../ui/dialog"
import { copyToClipboard } from "./helpers"

interface Props {
  data: JustCreatedKey
  onClose: () => void
  /** The Create button that opened this is disabled once the name clears, so focus goes here on close. */
  returnFocusTo?: RefObject<HTMLElement | null>
}

type CopyTarget = "key" | "curl" | "header"

export function JustCreatedKeyModal({ data, onClose, returnFocusTo }: Props) {
  const t = useT()
  const toast = useToast()
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const curl = `curl ${data.baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${data.key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'`

  const copy = async (target: CopyTarget, text: string) => {
    if (!(await copyToClipboard(text))) {
      toast.push(t("dash.clipboardUnavailable"), "error")
      return
    }
    setCopied(target)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 2000)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      onCloseAutoFocus={(event) => {
        const target = returnFocusTo?.current
        if (!target) return
        event.preventDefault()
        target.focus()
      }}
      title={t("dash.keyCreatedTitle")}
      description={t("dash.keyCreatedDesc")}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={() => copy("header", `Authorization: Bearer ${data.key}`)}>
            {copied === "header" ? <Check aria-hidden="true" className="text-success" /> : null}
            {t("dash.copyHeaderBtn")}
          </Button>
          <Button variant="primary" size="md" onClick={onClose}>
            {t("dash.doneBtn")}
          </Button>
        </>
      }
    >
      <div className="flex items-start justify-between gap-2 rounded-md border border-border bg-muted p-3">
        <span className="min-w-0 font-mono text-xs break-all text-fg">{data.key}</span>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={() => copy("key", data.key)}>
          {copied === "key" ? <Check aria-hidden="true" className="text-success" /> : null}
          {t("dash.copy")}
        </Button>
      </div>

      <div className="space-y-2">
        <h3 className="text-[13px] font-medium text-fg">{t("dash.quickTestCurl")}</h3>
        <CodeBlock
          language="bash"
          text={curl}
          copyLabel={t("dash.copy")}
          copied={copied === "curl"}
          onCopy={() => copy("curl", curl)}
        />
      </div>

      <p className="text-[13px] text-fg-muted">{t("dash.nextStepHint")}</p>
    </Dialog>
  )
}
