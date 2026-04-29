#!/usr/bin/env bun
import { getCopilotToken } from "../src/services/github/copilot-token"
import { copilotHeaders } from "../src/config/headers"
import { getCopilotBaseUrl, type AccountType } from "../src/config/constants"

const accountType = (process.env.ACCOUNT_TYPE ?? "individual") as AccountType
const baseUrl = getCopilotBaseUrl(accountType)
const gh = process.env.GH_TOKEN
if (!gh) throw new Error("set GH_TOKEN")
const minted = await getCopilotToken(gh)
const token = minted.token
console.log(`fresh copilot token, expires_at=${minted.expires_at}`)

interface Probe { label: string; method: "GET"|"POST"; path: string; body?: unknown }

const probes: Probe[] = [
  { label: "GET /search",                    method: "GET",  path: "/search" },
  { label: "GET /skills/search",             method: "GET",  path: "/skills/search" },
  { label: "GET /skills",                    method: "GET",  path: "/skills" },
  { label: "GET /skills/web-search",         method: "GET",  path: "/skills/web-search" },
  { label: "GET /agents/search",             method: "GET",  path: "/agents/search" },
  { label: "GET /agents",                    method: "GET",  path: "/agents" },

  // POST shapes
  { label: "POST /search {query}",           method: "POST", path: "/search",            body: { query: "what is github copilot" } },
  { label: "POST /search {q}",               method: "POST", path: "/search",            body: { q: "what is github copilot" } },
  { label: "POST /skills/web-search {query}",method: "POST", path: "/skills/web-search", body: { query: "what is github copilot" } },
  { label: "POST /skills/web-search {q}",    method: "POST", path: "/skills/web-search", body: { q: "what is github copilot" } },
  { label: "POST /skills/web-search {input}",method: "POST", path: "/skills/web-search", body: { input: "what is github copilot" } },
  { label: "POST /skills/web-search msgs",   method: "POST", path: "/skills/web-search", body: { messages: [{ role: "user", content: "search: latest claude release" }] } },

  // chat completions with web reference
  { label: "POST /chat/completions copilot_references=web", method: "POST", path: "/chat/completions", body: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "search the web: latest claude release" }],
      copilot_references: [{ type: "web", data: { query: "latest claude release" } }],
    } },
  { label: "POST /chat/completions copilot_skills=web-search", method: "POST", path: "/chat/completions", body: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "search: latest claude release" }],
      copilot_skills: ["web-search"],
    } },
]

for (const p of probes) {
  const res = await fetch(`${baseUrl}${p.path}`, {
    method: p.method,
    headers: copilotHeaders(token),
    body: p.body ? JSON.stringify(p.body) : undefined,
  })
  const txt = await res.text().catch(() => "")
  const snip = txt.length > 400 ? txt.slice(0, 400) + "…" : txt
  const tag = res.status === 404 ? "·" : "🟢"
  console.log(`${tag} [${res.status}] ${p.label}\n    ${snip.replace(/\s+/g, " ")}\n`)
}
