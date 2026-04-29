#!/usr/bin/env bun
/**
 * Probe how Copilot's /v1/responses endpoint reacts to a web_search tool
 * for gpt-5.x models. We need to know:
 *   - does it 400 (tool not supported, must convert to function)?
 *   - does it 200 and return a `web_search_call` output item?
 *   - does it 200 and return a regular `function_call`?
 *
 * Usage:
 *   GH_TOKEN=ghu_... bun run scripts/probe-responses-web-search.ts
 */

import { getCopilotToken } from "../src/services/github/copilot-token"
import { getCopilotBaseUrl, type AccountType } from "../src/config/constants"
import { copilotHeaders } from "../src/config/headers"

const accountType = (process.env.ACCOUNT_TYPE ?? "individual") as AccountType
const baseUrl = getCopilotBaseUrl(accountType)
const model = process.env.MODEL ?? "gpt-5"

async function getToken(): Promise<string> {
  if (process.env.COPILOT_TOKEN) return process.env.COPILOT_TOKEN
  const gh = process.env.GH_TOKEN
  if (!gh) throw new Error("Set GH_TOKEN or COPILOT_TOKEN")
  const res = await getCopilotToken(gh)
  console.log(`[ok] minted copilot token (expires_at=${res.expires_at})`)
  return res.token
}

interface Probe {
  label: string
  body: Record<string, unknown>
}

const baseInput = [
  {
    role: "user",
    content: [
      {
        type: "input_text",
        text: "What is the current weather in Beijing? Please use web search.",
      },
    ],
  },
]

const probes: Probe[] = [
  {
    label: "tools=[{type:'web_search'}]",
    body: {
      model,
      input: baseInput,
      tools: [{ type: "web_search" }],
      stream: false,
    },
  },
  {
    label: "tools=[{type:'web_search_preview'}]",
    body: {
      model,
      input: baseInput,
      tools: [{ type: "web_search_preview" }],
      stream: false,
    },
  },
  {
    label: "tools=[{type:'web_search_2025_03_11'}]",
    body: {
      model,
      input: baseInput,
      tools: [{ type: "web_search_2025_03_11" }],
      stream: false,
    },
  },
  {
    label: "tools=[function:web_search]",
    body: {
      model,
      input: baseInput,
      tools: [
        {
          type: "function",
          name: "web_search",
          description: "Search the web for up-to-date information.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
      stream: false,
    },
  },
]

async function probe(token: string, p: Probe): Promise<void> {
  const url = `${baseUrl}/v1/responses`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: copilotHeaders(token),
      body: JSON.stringify(p.body),
    })
  } catch (err) {
    console.log(`[net-fail] ${p.label} -> ${(err as Error).message}`)
    return
  }
  const status = res.status
  const bodyText = await res.text()
  const tag = status === 200 ? "🟢" : status >= 400 && status < 500 ? "🟡" : "🔴"
  console.log(`${tag} [${status}] ${p.label}`)
  if (status === 200) {
    try {
      const j = JSON.parse(bodyText) as { output?: unknown[]; usage?: unknown }
      console.log(`  output items: ${JSON.stringify(j.output, null, 2)}`)
      console.log(`  usage: ${JSON.stringify(j.usage)}`)
    } catch {
      console.log(bodyText.slice(0, 800))
    }
  } else {
    const snippet = bodyText.length > 800 ? `${bodyText.slice(0, 800)}…` : bodyText
    console.log(snippet.replace(/\n/g, "\n  "))
  }
  console.log("---")
}

async function main() {
  console.log(`base url: ${baseUrl}`)
  console.log(`model:    ${model}`)
  const token = await getToken()
  for (const p of probes) {
    // eslint-disable-next-line no-await-in-loop
    await probe(token, p)
  }
}

main().catch((err) => {
  console.error("probe failed:", err)
  process.exit(1)
})
