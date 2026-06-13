import { useEffect, useState } from "react"
import { Modal } from "../../components/Modal"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import {
  assignKeyToUser,
  loadAssignableKeys,
  unassignKeyFromUser,
  type KeyAssignmentInfo,
} from "../../api/users"

interface Props {
  userId: string
  userName: string
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

  return (
    <Modal open onClose={onClose} title={t("dash.assignKeysToTitle", { name: userName })} size="sm">
      {loading ? (
        <div className="text-center py-6 text-themed-dim text-xs">{t("dash.loadingShort")}</div>
      ) : keys.length === 0 ? (
        <div className="text-center py-6 text-themed-dim text-xs">{t("dash.noKeysAvailableShort")}</div>
      ) : (
        <>
          <div className="max-h-64 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
            {keys.map((k) => (
              <button
                key={k.id}
                onClick={() => toggle(k)}
                disabled={!!pending[k.id]}
                className={`flex items-center gap-3 py-2.5 px-1 w-full text-left cursor-pointer select-none transition-colors duration-100 rounded-md ${
                  k.assigned ? "hover:bg-accent-violet/5" : "hover:bg-white/[0.03]"
                }`}
              >
                <span
                  className={`w-[18px] h-[18px] rounded-full shrink-0 flex items-center justify-center transition-all duration-150 ${
                    k.assigned ? "bg-accent-violet" : ""
                  }`}
                  style={!k.assigned ? { border: "2px solid var(--surface-600)" } : undefined}
                >
                  {k.assigned ? <span className="text-white text-[10px]">✓</span> : null}
                </span>
                <span className={`text-[13px] ${k.assigned ? "text-themed font-medium" : "text-themed-dim"}`}>
                  {k.name}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between">
            <span className="text-[11px] text-themed-dim">
              <span className="text-accent-violet font-mono font-medium">{assignedCount}</span> / {keys.length} {t("dash.assignedSuffix")}
            </span>
            <button onClick={onClose} className="btn-primary text-xs">
              {t("dash.doneBtn")}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
