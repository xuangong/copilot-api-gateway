import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react"
import { cn } from "../../../ui/cn"

/** Ids a field hands to its control: the control's own id, the visible label's id, and the hint or error to describe it. */
export interface FieldIds {
  id: string
  labelId: string
  describedBy: string | undefined
}

/**
 * A visible label, a control and an optional hint or error below it.
 * The hint sits outside the label so it is not part of the control's name;
 * it is linked with aria-describedby instead. The label points at the control
 * with htmlFor, so pass `id` to the control; ui/select also takes
 * `labelledBy={labelId}`, which names it by label and current value.
 */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  /** Shown in place of the hint when set. */
  error?: ReactNode
  className?: string
  children: (ids: FieldIds) => ReactNode
}) {
  const id = useId()
  const labelId = `${id}-label`
  const noteId = `${id}-note`
  const note = error || hint
  return (
    <div className={cn("block", className)}>
      <label id={labelId} htmlFor={id} className="mb-1 block text-xs font-medium text-fg-muted">{label}</label>
      {children({ id, labelId, describedBy: note ? noteId : undefined })}
      {error ? (
        <p id={noteId} className="mt-1 text-xs text-danger">{error}</p>
      ) : hint ? (
        <p id={noteId} className="mt-1 text-xs text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  )
}

/** Uppercase section title (h4) used by the form's sections. */
export const sectionHeadingCls = "mb-2 text-body font-medium text-fg"

/**
 * Heading level of a form or panel title. A create panel sits straight under the
 * page h1 (title h2); an edit panel sits under a group h2 (title h3). Sections
 * and sub-sections follow from it, so the outline never skips a level.
 */
export const FormHeadingLevel = createContext(3)

/** A heading `offset` levels below the current form title. */
export function FormHeading({ offset = 0, ...props }: ComponentProps<"h2"> & { offset?: number }) {
  const level = Math.min(6, useContext(FormHeadingLevel) + offset)
  const Tag = `h${level}` as "h2"
  return <Tag {...props} />
}
/** Separator above each form section. */
export const sectionCls = "mt-3 border-t border-border pt-3"
