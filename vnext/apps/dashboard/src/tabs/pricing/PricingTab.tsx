import { useEffect, useState } from "react"
import { getPricing, type PricingCatalog, type PricingTier } from "../../api/pricing"
import { useT } from "../../state/i18n"

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

  if (error) return <div className="glass-card p-4 sm:p-6 text-sm text-accent-red">{error}</div>
  if (!data) return <div className="glass-card p-4 sm:p-6 text-sm text-themed-dim">{t("dash.loadingShort")}</div>

  return (
    <div className="flex flex-col gap-4">
      {data.providers.map((p) => (
        <div key={p.provider} className="glass-card p-4 sm:p-6 animate-in">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
            <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">
              {p.provider}
            </span>
            <div className="flex items-center gap-3 text-xs text-themed-dim">
              <span>
                {t("dash.pricing.verifiedOn")} {p.source.verifiedOn}
              </span>
              <a
                href={p.source.url}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-themed-secondary"
              >
                {t("dash.pricing.source")}
              </a>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-left text-xs text-themed-dim pb-3">
                {t("dash.pricing.caption")}
              </caption>
              <thead>
                <tr className="text-xs text-themed-dim uppercase tracking-wider">
                  <th className="text-left font-medium py-2 pr-4">{t("dash.pricing.model")}</th>
                  <th className="text-left font-medium py-2 pr-4">{t("dash.pricing.tier")}</th>
                  <th className="text-right font-medium py-2 pr-4">{t("dash.pricing.input")}</th>
                  <th className="text-right font-medium py-2 pr-4">{t("dash.pricing.cachedInput")}</th>
                  <th className="text-right font-medium py-2 pr-4">{t("dash.pricing.cacheWrite")}</th>
                  <th className="text-right font-medium py-2">{t("dash.pricing.output")}</th>
                </tr>
              </thead>
              <tbody>
                {p.models.flatMap((m) =>
                  m.tiers.map((tier, i) => (
                    <tr key={`${m.displayName}-${tier.label}`} className="border-t border-white/5">
                      <td className="py-2 pr-4 whitespace-nowrap">{i === 0 ? m.displayName : ""}</td>
                      <td className="py-2 pr-4 whitespace-nowrap text-themed-dim">
                        {tierLabel(tier, t("dash.pricing.default"))}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{usd(tier.pricing.input)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{usd(tier.pricing.input_cache_read)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{usd(tier.pricing.input_cache_write)}</td>
                      <td className="py-2 text-right tabular-nums">{usd(tier.pricing.output)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
