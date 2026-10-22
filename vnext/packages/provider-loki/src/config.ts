import { LOKI_BASE_URL, LOKI_PROFILE_ID } from "./profile"

export function lokiBaseUrl(value: unknown): string {
  if (value === undefined || value === "") return LOKI_BASE_URL
  if (typeof value !== "string") throw new Error("loki_invalid_endpoint")
  const raw = value.trim()
  if (!raw) return LOKI_BASE_URL
  if (raw.length > 2048 || /[\s\\]/.test(raw)) throw new Error("loki_invalid_endpoint")
  let url: URL
  try { url = new URL(raw) } catch { throw new Error("loki_invalid_endpoint") }
  if (url.protocol !== "https:" || url.username || url.password || raw.includes("?") || raw.includes("#")) {
    throw new Error("loki_invalid_endpoint")
  }
  return url.href.replace(/\/+$/, "")
}

export function normalizeLokiConfig(config: Record<string, unknown>) {
  if (config.profileId !== LOKI_PROFILE_ID) throw new Error("loki_invalid_profile")
  return { profileId: LOKI_PROFILE_ID,
    ...(config.baseUrl === undefined ? {} : { baseUrl: lokiBaseUrl(config.baseUrl) }) }
}
