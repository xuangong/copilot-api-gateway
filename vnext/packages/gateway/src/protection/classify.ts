// packages/gateway/src/protection/classify.ts
import { PROTECTION_MESSAGE_MAX, RISKY_CLASSES, SAMPLED_CLASSES, type ErrorClass } from "../repo/protection.ts"

const REJECTED = new Set([400, 404, 409, 413, 422])

/** The spec's table. A stream that starts with 2xx is `ok` whatever happens later. */
export function classifyStatus(status: number): ErrorClass {
  if (status >= 200 && status < 300) return "ok"
  if (status === 429) return "rate_limited"
  if (REJECTED.has(status)) return "rejected"
  if (status === 401 || status === 403) return "auth"
  if (status >= 500 && status < 600) return "upstream"
  return "other"
}

export const isRiskyClass = (cls: ErrorClass): boolean => (RISKY_CLASSES as readonly string[]).includes(cls)
export const isSampledClass = (cls: ErrorClass): boolean => SAMPLED_CLASSES.includes(cls)

const SOCKET_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket",
])
const TRANSPORT_PHRASE = /network connection lost|fetch failed|connection reset/i
const SOCKET_CODE_WORD = /\bECONN[A-Z]+\b/
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

/**
 * A thrown error is a `network` failure only when it looks like a transport failure. Caller aborts and
 * gateway-side errors (affinity fence, validation) return null: they never reached the upstream, or were not its fault.
 */
export function classifyThrown(error: unknown, signal?: AbortSignal): ErrorClass | null {
  if (signal?.aborted) return null
  if (!(error instanceof Error)) return null
  if (error.name === "AbortError") return null
  // Any TypeError counts as network (undici fetch failures are TypeErrors): accepted noise (D3), network is not a risky class.
  if (error.name === "TimeoutError" || error instanceof TypeError) return "network"
  const code = codeOf(error) ?? codeOf(error.cause)
  if (typeof code === "string" && SOCKET_CODES.has(code)) return "network"
  // Workers and some runtimes surface transport failures as a plain Error with no code.
  return TRANSPORT_PHRASE.test(error.message) || SOCKET_CODE_WORD.test(error.message) ? "network" : null
}

const TOKENISH = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g,
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abp]|tlm|ses|lks|sds|stl)[-_][A-Za-z0-9_-]{8,}/g,
  /\b[0-9a-fA-F]{32,}\b/g,
]
const KEY_VALUE = /\b(api[-_ ]?key|token|secret|password|authorization)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi
const BLOB = /[A-Za-z0-9+/=_-]{40,}/g
/** Random-looking base64 or token runs; URL and resource paths (slashes without `+` or a trailing `=`) are left alone. */
const isBlob = (run: string, before: string): boolean => {
  if (run.includes("/")) return run.includes("+") || run.endsWith("=")
  if (before === "/" || before === ".") return false
  return /\d/.test(run) && /[A-Za-z]/.test(run)
}
const INPUT_MAX = 8192
const CODE_MAX = 100
const tidy = (value: string, max = PROTECTION_MESSAGE_MAX): string => {
  let text = value
  for (const pattern of TOKENISH) text = text.replace(pattern, "[redacted]")
  text = text.replace(BLOB, (run, offset: number) => isBlob(run, text[offset - 1] ?? "") ? "[redacted]" : run)
  text = text.replace(KEY_VALUE, (all, name: string, sep: string, val: string) => /^[a-z]{1,7}$/.test(val) ? all : `${name}${sep}[redacted]`)
  return text.replace(/\s+/g, " ").trim().slice(0, max)
}
const tidyCode = (value: string): string => tidy(value, CODE_MAX)
const scalar = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : ""
const unescape = (raw: string): string => { try { return JSON.parse(`"${raw}"`) as string } catch { return raw } }

/** A truncated JSON body: pull out only the closed message/code/type string fields, never the raw text. */
function scrapeJson(body: string): { code: string; message: string } {
  const marker = /"error"\s*:\s*\{/.exec(body)
  if (!marker) return { code: "", message: "" }
  const inner = body.slice(marker.index + marker[0].length)
  const field = (name: string): string => {
    const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(inner)
    return m ? unescape(m[1]!) : ""
  }
  return { code: tidyCode(field("code") || field("type")), message: tidy(field("message")) }
}

/**
 * The upstream's own error description from a response body (the first few KiB). Request and response content is
 * never stored: only `error.message` and `error.code`/`error.type` shapes are read; HTML pages yield an empty message.
 */
export function extractErrorDetail(text: string): { code: string; message: string } {
  const body = text.slice(0, INPUT_MAX).trim()
  if (body === "") return { code: "", message: "" }
  let parsed: unknown
  let failed = false
  try { parsed = JSON.parse(body) } catch { parsed = undefined; failed = true }
  if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0]
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>
    const error = obj.error
    if (typeof error === "string") return { code: "", message: tidy(error) }
    if (error !== null && typeof error === "object") {
      const inner = error as Record<string, unknown>
      // Google shape: numeric `code` plus a string `status` such as RESOURCE_EXHAUSTED; the name is more useful.
      const code = typeof inner.code === "number" && typeof inner.status === "string" ? inner.status : scalar(inner.code) || scalar(inner.type)
      return { code: tidyCode(code), message: tidy(scalar(inner.message)) }
    }
    return { code: tidyCode(scalar(obj.code) || scalar(obj.type)), message: tidy(scalar(obj.message) || scalar(obj.detail)) }
  }
  if (failed && (body.startsWith("{") || body.startsWith("["))) return scrapeJson(body)
  if (body.startsWith("<") || parsed !== undefined) return { code: "", message: "" }
  return { code: "", message: tidy(body) }
}
