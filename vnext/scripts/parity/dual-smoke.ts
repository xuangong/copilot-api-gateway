#!/usr/bin/env bun
// Dual smoke: hit a representative slice of endpoints/models against
// root :41414 and vNext :41415, compare status + basic shape, and emit a
// short markdown summary so it's easy to spot regressions.
//
// Usage: bun run vnext/scripts/parity/dual-smoke.ts [--out path.md]

const ROOT = process.env.ROOT_URL ?? 'http://localhost:41414'
const VNEXT = process.env.VNEXT_URL ?? 'http://localhost:41415'
// Both gateways accept `Authorization: Bearer <api_key>`. vNext currently
// allows unauthenticated calls in this dev container; root requires the key.
// Sending it to both keeps the comparison apples-to-apples.
const ROOT_KEY = process.env.ROOT_API_KEY ?? ''
const VNEXT_KEY = process.env.VNEXT_API_KEY ?? ROOT_KEY

type Case = {
  name: string
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  stream?: boolean
  headers?: Record<string, string>
}

const CASES: Case[] = [
  { name: 'health', method: 'GET', path: '/health' },
  { name: 'models', method: 'GET', path: '/v1/models' },

  // OpenAI chat
  {
    name: 'chat:gpt-4o-mini:nonstream',
    method: 'POST',
    path: '/v1/chat/completions',
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'reply with the word OK' }], max_tokens: 10 },
  },
  {
    name: 'chat:gpt-4o-mini:stream',
    method: 'POST',
    path: '/v1/chat/completions',
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'count 1 to 3' }], stream: true, max_tokens: 30 },
    stream: true,
  },
  {
    name: 'chat:claude-haiku-4.5:stream',
    method: 'POST',
    path: '/v1/chat/completions',
    body: { model: 'claude-haiku-4.5', messages: [{ role: 'user', content: 'say hi' }], stream: true, max_tokens: 20 },
    stream: true,
  },
  {
    name: 'chat:gpt-5-mini:stream',
    method: 'POST',
    path: '/v1/chat/completions',
    body: { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'say hi' }], stream: true, max_tokens: 20 },
    stream: true,
  },

  // Anthropic messages
  {
    name: 'messages:claude-haiku-4.5:stream',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'anthropic-version': '2023-06-01' },
    body: {
      model: 'claude-haiku-4.5',
      messages: [{ role: 'user', content: 'say hi' }],
      max_tokens: 30,
      stream: true,
    },
    stream: true,
  },
  {
    name: 'messages:claude-sonnet-4.6:nonstream',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'anthropic-version': '2023-06-01' },
    body: {
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'reply with the word OK' }],
      max_tokens: 20,
    },
  },

  // OpenAI responses (Codex CLI shape)
  {
    name: 'responses:gpt-5.4:stream',
    method: 'POST',
    path: '/v1/responses',
    body: { model: 'gpt-5.4', input: 'say hi', stream: true },
    stream: true,
  },

  // Tool call (verifies whitespace abort does not misfire on normal tool args)
  {
    name: 'chat:tools:gpt-4o-mini:stream',
    method: 'POST',
    path: '/v1/chat/completions',
    body: {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'use the calc tool to add 5+3' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'calc',
            description: 'add two numbers',
            parameters: {
              type: 'object',
              properties: { a: { type: 'number' }, b: { type: 'number' } },
              required: ['a', 'b'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      stream: true,
      max_tokens: 80,
    },
    stream: true,
  },

  // Error path: bogus model -> structured error
  {
    name: 'error:bogus-model',
    method: 'POST',
    path: '/v1/chat/completions',
    body: { model: 'no-such-model-xyz', messages: [{ role: 'user', content: 'hi' }] },
  },
]

type RunResult = {
  status: number
  ms: number
  bytes: number
  events?: number
  errorText?: string
  sample: string
}

async function run(base: string, c: Case, key: string): Promise<RunResult> {
  const t0 = Date.now()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(c.headers ?? {}),
  }
  if (key) headers.Authorization = `Bearer ${key}`
  const init: RequestInit = {
    method: c.method,
    headers,
    body: c.body ? JSON.stringify(c.body) : undefined,
  }
  try {
    const res = await fetch(base + c.path, init)
    const text = await res.text()
    const ms = Date.now() - t0
    const bytes = text.length
    const result: RunResult = { status: res.status, ms, bytes, sample: text.slice(0, 200) }
    if (c.stream) {
      result.events = text.split('\n').filter((l) => l.startsWith('data:')).length
    }
    if (res.status >= 400) result.errorText = text.slice(0, 400)
    return result
  } catch (err: any) {
    return { status: 0, ms: Date.now() - t0, bytes: 0, sample: '', errorText: String(err?.message ?? err) }
  }
}

async function main() {
  const outIdx = process.argv.indexOf('--out')
  const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null

  const rows: string[] = []
  rows.push(`# Dual smoke root vs vNext`)
  rows.push('')
  rows.push(`Generated: ${new Date().toISOString()}`)
  rows.push('')
  rows.push(`Root: \`${ROOT}\` · vNext: \`${VNEXT}\``)
  rows.push('')
  rows.push(`| Case | root status | vNext status | root ms | vNext ms | root bytes | vNext bytes | parity |`)
  rows.push(`|---|---|---|---|---|---|---|---|`)

  const failures: { name: string; root: RunResult; vnext: RunResult }[] = []

  for (const c of CASES) {
    const [r, v] = await Promise.all([run(ROOT, c, ROOT_KEY), run(VNEXT, c, VNEXT_KEY)])
    const sameStatusFamily = Math.floor(r.status / 100) === Math.floor(v.status / 100)
    const bothOk = r.status < 400 && v.status < 400
    const parity = sameStatusFamily ? (bothOk ? '✅' : '⚠️ both error') : '❌ diverged'
    rows.push(
      `| \`${c.name}\` | ${r.status} | ${v.status} | ${r.ms} | ${v.ms} | ${r.bytes} | ${v.bytes} | ${parity} |`,
    )
    if (!sameStatusFamily) failures.push({ name: c.name, root: r, vnext: v })
    console.log(`[${c.name}] root=${r.status} vnext=${v.status} parity=${parity}`)
  }

  if (failures.length) {
    rows.push('')
    rows.push(`## Failures`)
    for (const f of failures) {
      rows.push('')
      rows.push(`### ${f.name}`)
      rows.push('')
      rows.push(`- **root** (\`${f.root.status}\`): ${'```'}${f.root.errorText ?? f.root.sample}${'```'}`)
      rows.push(`- **vNext** (\`${f.vnext.status}\`): ${'```'}${f.vnext.errorText ?? f.vnext.sample}${'```'}`)
    }
  }

  const md = rows.join('\n') + '\n'
  if (outPath) {
    await Bun.write(outPath, md)
    console.log(`\nwrote ${outPath}`)
  } else {
    console.log('\n' + md)
  }

  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
