import { useT } from "../state/i18n"

interface Props {
  group: string | null
  page: string | null
  /** Title for pages outside the groups (Settings, Agent Remote). */
  fallback: string
}

export function PageCrumb({ group, page, fallback }: Props) {
  const t = useT()
  // "Models / Models" says the same thing twice: a page named like its group stands alone.
  const shownGroup = group !== null && group !== page ? group : null
  return (
    <nav aria-label={t("dash.nav.breadcrumb")} className="mb-4 hidden text-body md:block">
      <ol className="flex items-center gap-1.5 text-fg-subtle">
        {shownGroup ? (
          <>
            <li>{shownGroup}</li>
            <li aria-hidden="true">/</li>
          </>
        ) : null}
        <li aria-current="page" className="font-medium text-fg">{page ?? fallback}</li>
      </ol>
    </nav>
  )
}
