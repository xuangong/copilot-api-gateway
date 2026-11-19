/**
 * Record/replay of real upstream HTTP exchanges ("cassettes"), so translation
 * and provider tests can exercise the actual wire format — including SSE —
 * without credentials or network. Modelled on LiteLLM's VCR testing
 * (https://github.com/BerriAI/litellm/blob/main/tests/VCR_TESTING.md):
 * only 2xx responses are recorded, request headers are never stored, and
 * credentials are scrubbed from URLs and JSON bodies.
 *
 * Replay is strict: each request must match the next unused interaction by
 * method, URL and body hash, or the fetcher throws — a test can never fall
 * through to the network. `recordedAt` lets a freshness check flag cassettes
 * old enough that upstream drift may have made them unrepresentative.
 */
import type { Fetcher } from "@vibe-core/upstream"

export interface CassetteInteraction {
  request: { method: string; url: string; bodySha256: string }
  response: { status: number; headers: Record<string, string>; body: string }
}

export interface Cassette {
  recordedAt: string
  interactions: CassetteInteraction[]
}

const SECRET_QUERY = /^(key|api[-_]?key|access_token|token)$/i
const SECRET_FIELD = /^(token|access_token|refresh_token|id_token|api_key|apiKey|secret|client_secret)$/
const DROPPED_RESPONSE_HEADERS = new Set(["set-cookie", "authorization", "x-api-key", "content-length", "content-encoding"])
export const SCRUBBED = "<scrubbed>"

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

/** URL with credential-bearing query parameters replaced. */
export function scrubUrl(raw: string): string {
  const url = new URL(raw)
  for (const name of [...url.searchParams.keys()]) if (SECRET_QUERY.test(name)) url.searchParams.set(name, SCRUBBED)
  return url.toString()
}

/** JSON text with credential-named fields replaced; non-JSON text (e.g. SSE) has each `data:` JSON line scrubbed. */
export function scrubBody(text: string): string {
  const scrubValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrubValue)
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_FIELD.test(k) && typeof v === "string" ? SCRUBBED : scrubValue(v)]))
    }
    return value
  }
  const scrubJson = (raw: string): string => {
    try { return JSON.stringify(scrubValue(JSON.parse(raw))) } catch { return raw }
  }
  const trimmed = text.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return scrubJson(text)
  return text.split("\n").map(line => line.startsWith("data: ") ? `data: ${scrubJson(line.slice(6))}` : line).join("\n")
}

async function requestKey(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request && init === undefined ? input : new Request(input as RequestInfo, init)
  const body = request.body ? await request.clone().text() : ""
  return { method: request.method, url: scrubUrl(request.url), bodySha256: await sha256(body) }
}

/** Replays a cassette strictly, in order. */
export function replayFetcher(cassette: Cassette): Fetcher & { remaining(): number } {
  let next = 0
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = await requestKey(input, init)
    const interaction = cassette.interactions[next]
    if (!interaction || interaction.request.method !== key.method || interaction.request.url !== key.url || interaction.request.bodySha256 !== key.bodySha256) {
      throw new Error(`cassette mismatch at interaction ${next}: got ${key.method} ${key.url} (body ${key.bodySha256.slice(0, 8)}), expected ${interaction ? `${interaction.request.method} ${interaction.request.url} (body ${interaction.request.bodySha256.slice(0, 8)})` : "no further interaction"}`)
    }
    next++
    return new Response(interaction.response.body, { status: interaction.response.status, headers: interaction.response.headers })
  }) as Fetcher & { remaining(): number }
  fetcher.remaining = () => cassette.interactions.length - next
  return fetcher
}

/** Passes requests to `real` and records scrubbed 2xx exchanges; `cassette()` returns what was recorded. */
export function recordingCassetteFetcher(real: Fetcher, now: () => Date = () => new Date()): Fetcher & { cassette(): Cassette } {
  const interactions: CassetteInteraction[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = await requestKey(input, init)
    const response = await real(input as never, init as never)
    if (response.status < 200 || response.status >= 300) return response
    const body = await response.clone().text()
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => { if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers[name] = value })
    interactions.push({ request: key, response: { status: response.status, headers, body: scrubBody(body) } })
    return response
  }) as Fetcher & { cassette(): Cassette }
  fetcher.cassette = () => ({ recordedAt: now().toISOString(), interactions: structuredClone(interactions) })
  return fetcher
}

/** Days since the cassette was recorded. */
export function cassetteAgeDays(cassette: Cassette, now: Date = new Date()): number {
  return (now.getTime() - Date.parse(cassette.recordedAt)) / 86_400_000
}
