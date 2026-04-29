#!/usr/bin/env bun
/**
 * Probe whether the GitHub Copilot upstream exposes any kind of native search endpoint.
 *
 * Usage:
 *   GH_TOKEN=ghu_xxx bun run scripts/probe-search.ts
 *   # or pass an already-minted Copilot token:
 *   COPILOT_TOKEN=tid=... bun run scripts/probe-search.ts
 *   # account type, default "individual" (other options: "business", "enterprise")
 *   ACCOUNT_TYPE=individual bun run scripts/probe-search.ts
 */

import { getCopilotToken } from "../src/services/github/copilot-token"
import { getCopilotBaseUrl, type AccountType } from "../src/config/constants"
import { copilotHeaders } from "../src/config/headers"

const accountType = (process.env.ACCOUNT_TYPE ?? "individual") as AccountType
const baseUrl = getCopilotBaseUrl(accountType)

async function getToken(): Promise<string> {
  if (process.env.COPILOT_TOKEN) return process.env.COPILOT_TOKEN
  const gh = process.env.GH_TOKEN
  if (!gh) throw new Error("Set GH_TOKEN or COPILOT_TOKEN env var")
  const res = await getCopilotToken(gh)
  console.log(`[ok] minted copilot token (expires_at=${res.expires_at})`)
  return res.token
}

interface Probe {
  label: string
  method: "GET" | "POST"
  path: string
  body?: unknown
}

// Candidate endpoints — pure GETs probe surface; POSTs probe whether the path
// accepts a search-shaped body. A 404 means "doesn't exist". A 400/415/422
// often means "exists but body is wrong" — that's interesting.
const probes: Probe[] = [
  // Bare path probes
  { label: "GET /search",                 method: "GET",  path: "/search" },
  { label: "GET /v1/search",              method: "GET",  path: "/v1/search" },
  { label: "GET /web/search",             method: "GET",  path: "/web/search" },
  { label: "GET /web_search",             method: "GET",  path: "/web_search" },
  { label: "GET /bing/search",            method: "GET",  path: "/bing/search" },
  { label: "GET /chat/search",            method: "GET",  path: "/chat/search" },
  { label: "GET /skills/search",          method: "GET",  path: "/skills/search" },
  { label: "GET /agents/search",          method: "GET",  path: "/agents/search" },
  { label: "GET /tools/web_search",       method: "GET",  path: "/tools/web_search" },

  // POST with search-shaped bodies
  { label: "POST /search?q=...",          method: "POST", path: "/search",       body: { query: "what is github copilot", q: "what is github copilot" } },
  { label: "POST /v1/search",             method: "POST", path: "/v1/search",    body: { query: "what is github copilot" } },
  { label: "POST /web/search",            method: "POST", path: "/web/search",   body: { query: "what is github copilot" } },
  { label: "POST /skills/web-search",     method: "POST", path: "/skills/web-search", body: { query: "what is github copilot" } },
  { label: "POST /chat/completions+web",  method: "POST", path: "/chat/completions", body: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "search the web: latest claude release" }],
      // VS Code-style web reference hint, if such a thing exists
      copilot_references: [{ type: "web", data: { query: "latest claude release" } }],
    } },
]

async function probe(token: string, p: Probe): Promise<void> {
  const url = `${baseUrl}${p.path}`
  let res: Response
  try {
    res = await fetch(url, {
      method: p.method,
      headers: copilotHeaders(token),
      body: p.body ? JSON.stringify(p.body) : undefined,
    })
  } catch (err) {
    console.log(`[net-fail] ${p.label} -> ${(err as Error).message}`)
    return
  }

  const status = res.status
  let bodyText = ""
  try {
    bodyText = await res.text()
  } catch {
    bodyText = "(failed to read body)"
  }
  const snippet = bodyText.length > 240 ? `${bodyText.slice(0, 240)}…` : bodyText

  // Interesting = anything that is NOT a flat 404
  const interesting = status !== 404
  const tag = interesting ? "🟢" : "·"
  console.log(`${tag} [${status}] ${p.label}\n    ${snippet.replace(/\s+/g, " ")}`)
}

async function main() {
  console.log(`base url: ${baseUrl}`)
  const token = await getToken()
  console.log(`probing ${probes.length} candidate endpoints…\n`)
  for (const p of probes) {
    // serial to keep output readable & avoid rate-limit
    // eslint-disable-next-line no-await-in-loop
    await probe(token, p)
  }
  console.log("\ndone. anything marked 🟢 is worth investigating.")
}

main().catch((err) => {
  console.error("probe failed:", err)
  process.exit(1)
})
