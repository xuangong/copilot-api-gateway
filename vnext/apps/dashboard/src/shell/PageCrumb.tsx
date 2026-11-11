import { useT } from "../state/i18n"

interface Props {
  group: string | null
  page: string | null
  /** Title for pages outside the groups (Settings, Agent Remote). */
  fallback: string
}

export function PageCrumb({ group, page, fallback }: Props) {
  const t = useT()
  return (
    <nav aria-label={t("dash.nav.breadcrumb")} className="mb-4 hidden text-[13px] md:block">
      <ol className="flex items-center gap-1.5 text-fg-subtle">
        {group ? (
          <>
            <li>{group}</li>
            <li aria-hidden="true">/</li>
          </>
        ) : null}
        <li aria-current="page" className="font-medium text-fg">{page ?? fallback}</li>
      </ol>
    </nav>
  )
}
