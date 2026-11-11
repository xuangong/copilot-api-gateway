import { useEffect, useId, useState } from "react"
import { getPricing, type PricingCatalog, type PricingTier } from "../../api/pricing"
import { useT } from "../../state/i18n"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { PageHeader } from "../../ui/page-header"
import { Table, TBody, Td, Th } from "../../ui/table"

/** "5.00", "0.075", "—" — two decimals unless a third is significant. */
function usd(v: number | undefined): string {
  if (v === undefined) return "—"
  const three = v.toFixed(3)
  return three.endsWith("0") ? v.toFixed(2) : three
}

function tierLabel(tier: PricingTier, defaultLabel: string): string {
  if (tier.contextThreshold === undefined) return defaultLabel
  return `> ${Math.round(tier.contextThreshold / 1000)}K`
}

export function PricingTab() {
  const t = useT()
  const [data, setData] = useState<PricingCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const idBase = useId()

  useEffect(() => {
    let alive = true
    getPricing()
      .then((d) => {
        if (alive) setData(d)
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [])

  const header = <PageHeader title={t("dash.pricing")} />
  if (error) {
    return (
      <div>
        {header}
        <Notice tone="danger">{error}</Notice>
      </div>
    )
  }
  if (!data) {
    return (
      <div>
        {header}
        <p role="status" className="text-sm text-fg-subtle">{t("dash.loadingShort")}</p>
      </div>
    )
  }

  return (
    <div>
      {header}
      <div className="flex flex-col gap-4">
        {data.providers.map((p, index) => {
          const headingId = `${idBase}-${index}`
          return (
            <Card key={p.provider} aria-labelledby={headingId} className="sm:p-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                <SectionHeading id={headingId} className="text-xs font-medium text-fg-subtle uppercase tracking-widest">
                  {p.provider}
                </SectionHeading>
                <div className="flex items-center gap-3 text-xs text-fg-subtle">
                  <span>
                    {t("dash.pricing.verifiedOn")} {p.source.verifiedOn}
                  </span>
                  <a
                    href={p.source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-sm underline hover:text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
                  >
                    {t("dash.pricing.source")}
                  </a>
                </div>
              </div>

              <Table className="text-sm">
                <caption className="text-left text-xs text-fg-subtle pb-3">
                  {t("dash.pricing.caption")}
                </caption>
                <thead>
                  <tr>
                    <Th className="uppercase tracking-wider">{t("dash.pricing.model")}</Th>
                    <Th className="uppercase tracking-wider">{t("dash.pricing.tier")}</Th>
                    <Th numeric className="uppercase tracking-wider">{t("dash.pricing.input")}</Th>
                    <Th numeric className="uppercase tracking-wider">{t("dash.pricing.cachedInput")}</Th>
                    <Th numeric className="uppercase tracking-wider">{t("dash.pricing.cacheWrite")}</Th>
                    <Th numeric className="uppercase tracking-wider">{t("dash.pricing.output")}</Th>
                  </tr>
                </thead>
                <TBody>
                  {p.models.flatMap((m) =>
                    m.tiers.map((tier, i) => (
                      <tr key={`${m.displayName}-${tier.label}`}>
                        {/* Later tiers keep a blank model cell, but still name the model for screen readers. */}
                        <Th row className="whitespace-nowrap">
                          {i === 0 ? m.displayName : <span className="sr-only">{m.displayName}</span>}
                        </Th>
                        <Td className="whitespace-nowrap text-fg-subtle">
                          {tierLabel(tier, t("dash.pricing.default"))}
                        </Td>
                        <Td numeric>{usd(tier.pricing.input)}</Td>
                        <Td numeric>{usd(tier.pricing.input_cache_read)}</Td>
                        <Td numeric>{usd(tier.pricing.input_cache_write)}</Td>
                        <Td numeric>{usd(tier.pricing.output)}</Td>
                      </tr>
                    )),
                  )}
                </TBody>
              </Table>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
