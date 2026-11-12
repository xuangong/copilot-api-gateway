import { useEffect, useState } from "react"
import { Check } from "lucide-react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import {
  assignKeyToUser,
  loadAssignableKeys,
  unassignKeyFromUser,
  type KeyAssignmentInfo,
} from "../../api/users"
import { Button } from "../../ui/button"
import { cn } from "../../ui/cn"
import { Dialog } from "../../ui/dialog"

interface Props {
  userId: string
  userName: string
  /** Called on every close (Esc, overlay click, Done); the caller reloads users. */
  onClose: () => void
}

export function AssignKeysModal({ userId, userName, onClose }: Props) {
  const { push: toast } = useToast()
  const t = useT()
  const [loading, setLoading] = useState(true)
  const [keys, setKeys] = useState<KeyAssignmentInfo[]>([])
  const [pending, setPending] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadAssignableKeys(userId)
      .then((list) => {
        if (!cancelled) setKeys(list)
      })
      .catch((e: unknown) => {
        if (!cancelled) toast(e instanceof Error ? e.message : String(e), "error")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [userId, toast])

  const toggle = async (k: KeyAssignmentInfo) => {
    if (pending[k.id]) return
    setPending((p) => ({ ...p, [k.id]: true }))
    try {
      if (k.assigned) {
        await unassignKeyFromUser(k.id, userId)
      } else {
        await assignKeyToUser(k.id, userId)
      }
      setKeys((cur) => cur.map((x) => (x.id === k.id ? { ...x, assigned: !k.assigned } : x)))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setPending((p) => {
        const { [k.id]: _drop, ...rest } = p
        return rest
      })
    }
  }

  const assignedCount = keys.filter((k) => k.assigned).length
  const showList = !loading && keys.length > 0

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={t("dash.assignKeysToTitle", { name: userName })}
      className="max-w-sm"
      footer={
        showList ? (
          <div className="flex flex-1 items-center justify-between gap-3">
            <span className="text-xs text-fg-muted tabular-nums">
              <span className="font-mono font-medium text-brand-text">{assignedCount}</span> / {keys.length} {t("dash.assignedSuffix")}
            </span>
            <Button variant="primary" size="sm" onClick={onClose}>
              {t("dash.doneBtn")}
            </Button>
          </div>
        ) : undefined
      }
    >
      {loading ? (
        <div className="text-center py-6 text-fg-muted text-xs">{t("dash.loadingShort")}</div>
      ) : keys.length === 0 ? (
        <div className="text-center py-6 text-fg-muted text-xs">{t("dash.noKeysAvailableShort")}</div>
      ) : (
        <div className="max-h-64 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
          {keys.map((k) => {
            const busy = !!pending[k.id]
            return (
              // aria-disabled rather than disabled: a disabled button drops focus, which would
              // throw keyboard users out of the list mid-toggle.
              <button
                key={k.id}
                type="button"
                role="checkbox"
                aria-checked={k.assigned}
                aria-disabled={busy || undefined}
                onClick={() => toggle(k)}
                className={cn(
                  "flex items-center gap-3 py-2.5 px-1 w-full text-left cursor-pointer select-none transition-colors duration-100 rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
                  busy && "cursor-default opacity-50",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-[18px] rounded-full shrink-0 flex items-center justify-center transition-colors duration-150",
                    k.assigned ? "bg-brand text-brand-fg" : "border-2 border-control",
                  )}
                >
                  {k.assigned ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
                <span className={cn("text-body", k.assigned ? "text-fg font-medium" : "text-fg-muted")}>{k.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </Dialog>
  )
}
