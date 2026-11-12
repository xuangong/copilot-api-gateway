import { dateLocale, t } from "./i18n"

export type TimeAgoStyle = "short" | "long"

/**
 * How long ago, in the interface language: "5m ago" (short, for dense rows) or
 * "5 minutes ago" (long); past 30 days, the date. Empty for a missing or
 * unparseable time; a time in the future counts as just now.
 */
export function timeAgo(value: string | null | undefined, nowMs: number = Date.now(), style: TimeAgoStyle = "short"): string {
  if (!value) return ""
  const at = new Date(value).getTime()
  if (Number.isNaN(at)) return ""
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000))
  if (seconds < 60) return t("dash.justNow")
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    if (style === "short") return t("dash.minutesAgoShort", { n: minutes })
    return minutes === 1 ? t("dash.oneMinuteAgo") : t("dash.minutesAgo", { n: minutes })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    if (style === "short") return t("dash.hoursAgoShort", { n: hours })
    return hours === 1 ? t("dash.oneHourAgo") : t("dash.hoursAgo", { n: hours })
  }
  const days = Math.floor(hours / 24)
  if (days <= 30) {
    if (style === "short") return t("dash.daysAgoShort", { n: days })
    return days === 1 ? t("dash.oneDayAgo") : t("dash.daysAgo", { n: days })
  }
  return new Date(at).toLocaleDateString(dateLocale(), { month: "short", day: "numeric", year: "numeric" })
}
