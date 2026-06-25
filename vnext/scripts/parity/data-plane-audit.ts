#!/usr/bin/env bun
/**
 * Spec 12a — Data-Plane Parity Audit harness.
 *
 * Compares root src/ (PORT=4141) and vnext (PORT=41415) across 27 fixtures.
 * Emits structural diff report to vnext/docs/superpowers/research/.
 *
 * Spec: vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type DiffRules,
  type GapLabel,
  type DiffEntry,
  diffStatus,
  maskHeaderValue,
  diffHeaders as _diffHeaders,
  diffJsonBody as _diffJsonBody,
  aggregateLabel,
} from './lib/diff'

// Re-export types and lib functions for external consumers (e.g. diff-engine.test.ts).
export type { DiffRules, GapLabel, DiffEntry }
export { maskHeaderValue, aggregateLabel, diffStatus }

// ---------- Data-plane rules ----------

const DATA_PLANE_RULES: DiffRules = {
  ignoreKeys: new Set([
    'id', 'created', 'created_at', 'system_fingerprint', 'x_request_id',
    'response_id', 'fingerprint',
    // Copilot vendor padding — random bytes per request, content carries no semantic info.
    // Presence-checked via captureExtras; value diff is nondeterministic upstream noise.
    'padding',
    // Provenance markers on /v1/models — embed the storage UUID of the upstream row.
    // Root's seeded fixed UUID and vnext's random UUID differ by instance, not by
    // behavior. The model JSON itself (capabilities, supports, tokenizer, etc.) is
    // what data-plane parity validates.
    '_upstream',
  ]),
  headerAllowlist: new Set(['content-type', 'x-request-id', 'transfer-encoding', 'cache-control']),
  // data-plane has no strong-enum keys — strong-field handling lives in deepDiff
}

// 2-arg wrapper for backward compat (diff-engine.test.ts imports these from here)
export function diffHeaders(
  rootHeaders: Record<string, string>,
  vnextHeaders: Record<string, string>,
): DiffEntry[] {
  return _diffHeaders(rootHeaders, vnextHeaders, DATA_PLANE_RULES)
}

export function diffJsonBody(rootBody: unknown, vnextBody: unknown): DiffEntry[] {
  return _diffJsonBody(rootBody, vnextBody, DATA_PLANE_RULES)
}

// ---------- Types ----------

export interface Fixture {
  name: string
  endpoint: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: unknown
  expect_stream: boolean
}

export interface FetchResult {
  status: number
  headers: Record<string, string>
  // For non-stream: parsed JSON or raw text fallback.
  // For stream: raw SSE text body.
  body: unknown
  raw: string
}

export interface FixtureReport {
  fixture: string
  endpoint: string
  rootStatus: number
  vnextStatus: number
  label: GapLabel
  diffs: DiffEntry[]
}

// ---------- Env / config ----------

const ROOT_BASE = process.env.PARITY_ROOT_BASE ?? 'http://127.0.0.1:4141'
const VNEXT_BASE = process.env.PARITY_VNEXT_BASE ?? 'http://127.0.0.1:41415'
const API_KEY = process.env.PARITY_API_KEY ?? ''
const ROOT_API_KEY = process.env.PARITY_ROOT_API_KEY ?? API_KEY
const VNEXT_API_KEY = process.env.PARITY_VNEXT_API_KEY ?? API_KEY
const FIXTURE_DIR = join(import.meta.dir, 'fixtures/data-plane')
const REPORT_PATH = process.env.PARITY_REPORT_PATH
  ?? join(import.meta.dir, '../../docs/superpowers/research/2026-06-25-spec12a-parity-report.md')

// ---------- Fixture loader ----------

export function loadFixtures(dir: string = FIXTURE_DIR): Fixture[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  return files.map((f) => {
    const raw = readFileSync(join(dir, f), 'utf8')
    return JSON.parse(raw) as Fixture
  })
}

// ---------- Diff: SSE (structural-only) ----------

export interface SseMessage {
  event: string | null
  // Structural: detected delta kind (text / tool_use / stop / done / other) — NOT content.
  kind: string
}

export function parseSse(raw: string): SseMessage[] {
  const out: SseMessage[] = []
  const blocks = raw.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    if (!block.trim()) continue
    let event: string | null = null
    let dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    const data = dataLines.join('\n')
    out.push({ event, kind: classifySseData(data) })
  }
  return out
}

function classifySseData(data: string): string {
  if (data === '[DONE]') return 'done'
  let parsed: unknown
  try { parsed = JSON.parse(data) } catch { return 'raw' }
  if (typeof parsed !== 'object' || parsed === null) return 'primitive'
  const obj = parsed as Record<string, unknown>
  // Anthropic / OpenAI / Gemini common shapes
  if (obj.type === 'message_stop' || obj.type === 'content_block_stop') return 'stop'
  if (obj.type === 'content_block_delta' || obj.delta != null) {
    const delta = (obj.delta ?? {}) as Record<string, unknown>
    if (delta.type === 'input_json_delta' || delta.tool_calls != null) return 'tool_use'
    if (typeof delta.text === 'string' || typeof delta.content === 'string') return 'text'
    return 'delta-other'
  }
  if (Array.isArray(obj.choices)) {
    const choice = (obj.choices[0] ?? {}) as Record<string, unknown>
    const delta = (choice.delta ?? {}) as Record<string, unknown>
    if (delta.tool_calls != null) return 'tool_use'
    if (typeof delta.content === 'string') return 'text'
    if (choice.finish_reason != null) return 'stop'
    return 'delta-other'
  }
  if (Array.isArray(obj.candidates)) return 'text' // Gemini chunk
  return 'other'
}

export function diffSse(rootRaw: string, vnextRaw: string): DiffEntry[] {
  const r = parseSse(rootRaw)
  const v = parseSse(vnextRaw)
  const out: DiffEntry[] = []
  if (r.length !== v.length) {
    out.push({ layer: 'sse', label: 'behavior-gap', detail: `event count root=${r.length} vnext=${v.length}` })
    return out
  }
  for (let i = 0; i < r.length; i++) {
    if (r[i].event !== v[i].event) {
      out.push({ layer: 'sse', label: 'behavior-gap', detail: `[${i}] event root=${r[i].event} vnext=${v[i].event}` })
    }
    if (r[i].kind !== v[i].kind) {
      out.push({ layer: 'sse', label: 'behavior-gap', detail: `[${i}] kind root=${r[i].kind} vnext=${v[i].kind}` })
    }
  }
  return out
}

// ---------- HTTP execution ----------

export interface MultipartBody {
  multipart: true
  fields: Record<string, string | number>
  files: Record<string, { filename: string; content_type: string; base64: string }>
}

function isMultipart(body: unknown): body is MultipartBody {
  return typeof body === 'object' && body !== null && (body as { multipart?: unknown }).multipart === true
}

function buildMultipart(body: MultipartBody): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(body.fields)) {
    fd.append(k, String(v))
  }
  for (const [k, f] of Object.entries(body.files)) {
    const bin = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))
    fd.append(k, new Blob([bin], { type: f.content_type }), f.filename)
  }
  return fd
}

export function substitutePlaceholders(input: unknown, vars: Record<string, string>): unknown {
  if (typeof input === 'string') {
    let out = input
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`\${${k}}`).join(v)
    }
    return out
  }
  if (Array.isArray(input)) return input.map((x) => substitutePlaceholders(x, vars))
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = substitutePlaceholders(v, vars)
    }
    return out
  }
  return input
}

export async function fetchSide(
  base: string,
  fx: Fixture,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchResult> {
  const url = `${base}${fx.endpoint}`
  const init: RequestInit = { method: fx.method, headers: { ...fx.headers } }
  if (fx.method !== 'GET' && fx.body !== undefined) {
    if (isMultipart(fx.body)) {
      init.body = buildMultipart(fx.body)
      const h = init.headers as Record<string, string>
      delete h['content-type']
      delete h['Content-Type']
    } else {
      init.body = typeof fx.body === 'string' ? fx.body : JSON.stringify(fx.body)
      const h = init.headers as Record<string, string>
      if (!('content-type' in h) && !('Content-Type' in h)) h['content-type'] = 'application/json'
    }
  }
  const resp = await fetchImpl(url, init)
  const headers: Record<string, string> = {}
  resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
  const raw = await resp.text()
  let body: unknown = raw
  if (!fx.expect_stream) {
    try { body = JSON.parse(raw) } catch { /* keep raw */ }
  }
  return { status: resp.status, headers, body, raw }
}

export function runFixture(
  fx: Fixture,
  root: FetchResult,
  vnext: FetchResult,
): FixtureReport {
  const diffs: DiffEntry[] = []

  // route-missing: vnext returned 404/405 while root did not
  if ((vnext.status === 404 || vnext.status === 405) && root.status < 400) {
    diffs.push({
      layer: 'status',
      label: 'route-missing',
      detail: `vnext returned ${vnext.status} for ${fx.endpoint}; root returned ${root.status}`,
    })
    return {
      fixture: fx.name,
      endpoint: fx.endpoint,
      rootStatus: root.status,
      vnextStatus: vnext.status,
      label: 'route-missing',
      diffs,
    }
  }

  diffs.push(...diffStatus(root.status, vnext.status))
  diffs.push(...diffHeaders(root.headers, vnext.headers))
  if (fx.expect_stream) {
    diffs.push(...diffSse(root.raw, vnext.raw))
  } else {
    diffs.push(...diffJsonBody(root.body, vnext.body))
  }

  return {
    fixture: fx.name,
    endpoint: fx.endpoint,
    rootStatus: root.status,
    vnextStatus: vnext.status,
    label: aggregateLabel(diffs),
    diffs,
  }
}

// ---------- Report writer ----------

export function renderReport(reports: FixtureReport[]): string {
  const counts: Record<GapLabel, number> = {
    parity: 0,
    'cosmetic-diff': 0,
    'behavior-gap': 0,
    'route-missing': 0,
  }
  for (const r of reports) counts[r.label]++

  const lines: string[] = []
  lines.push('# Spec 12a — Data-Plane Parity Report')
  lines.push('')
  lines.push(`**Generated:** ${new Date().toISOString()}`)
  lines.push(`**Fixtures:** ${reports.length}`)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push('| label | count |')
  lines.push('|-------|-------|')
  lines.push(`| parity | ${counts.parity} |`)
  lines.push(`| cosmetic-diff | ${counts['cosmetic-diff']} |`)
  lines.push(`| behavior-gap | ${counts['behavior-gap']} |`)
  lines.push(`| route-missing | ${counts['route-missing']} |`)
  lines.push('')
  lines.push('## Per-fixture')
  lines.push('')
  lines.push('| endpoint | fixture | label | root | vnext | summary |')
  lines.push('|----------|---------|-------|------|-------|---------|')
  for (const r of reports) {
    const summary = r.diffs.length === 0 ? '—' : r.diffs.slice(0, 3).map((d) => `${d.layer}:${d.label}`).join(' / ')
    lines.push(`| \`${r.endpoint}\` | ${r.fixture} | **${r.label}** | ${r.rootStatus} | ${r.vnextStatus} | ${summary} |`)
  }
  lines.push('')
  lines.push('## Appendix — full diffs')
  lines.push('')
  for (const r of reports) {
    lines.push(`### ${r.fixture} (\`${r.endpoint}\`) — ${r.label}`)
    lines.push('')
    if (r.diffs.length === 0) {
      lines.push('No diffs.')
    } else {
      for (const d of r.diffs) {
        lines.push(`- **${d.layer}** [${d.label}] ${d.detail}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ---------- CLI entry ----------

async function main(): Promise<void> {
  if (!ROOT_API_KEY || !VNEXT_API_KEY) {
    console.error('[parity] PARITY_ROOT_API_KEY and PARITY_VNEXT_API_KEY (or PARITY_API_KEY) required')
    process.exit(2)
  }
  const fixtures = loadFixtures()
  console.error(`[parity] loaded ${fixtures.length} fixtures from ${FIXTURE_DIR}`)
  console.error(`[parity] root=${ROOT_BASE} vnext=${VNEXT_BASE}`)

  const ordered = [...fixtures].sort((a, b) => {
    const aChain = a.name === 'responses-stateful-chain' ? 1 : 0
    const bChain = b.name === 'responses-stateful-chain' ? 1 : 0
    if (aChain !== bChain) return aChain - bChain
    return a.name.localeCompare(b.name)
  })

  const vars: Record<string, string> = {}
  const reports: FixtureReport[] = []

  const sideFx = (fx: Fixture, apiKey: string): Fixture => ({
    ...fx,
    headers: substitutePlaceholders(fx.headers, { ...vars, API_KEY: apiKey }) as Record<string, string>,
    body: substitutePlaceholders(fx.body, { ...vars, API_KEY: apiKey }),
  })

  for (const fxOriginal of ordered) {
    console.error(`[parity] → ${fxOriginal.name} (${fxOriginal.method} ${fxOriginal.endpoint})`)

    let root: FetchResult
    let vnext: FetchResult
    try {
      root = await fetchSide(ROOT_BASE, sideFx(fxOriginal, ROOT_API_KEY))
    } catch (err) {
      console.error(`[parity]   root fetch failed: ${(err as Error).message}`)
      reports.push({
        fixture: fxOriginal.name, endpoint: fxOriginal.endpoint,
        rootStatus: 0, vnextStatus: 0,
        label: 'behavior-gap',
        diffs: [{ layer: 'status', label: 'behavior-gap', detail: `root fetch error: ${(err as Error).message}` }],
      })
      continue
    }
    try {
      vnext = await fetchSide(VNEXT_BASE, sideFx(fxOriginal, VNEXT_API_KEY))
    } catch (err) {
      console.error(`[parity]   vnext fetch failed: ${(err as Error).message}`)
      reports.push({
        fixture: fxOriginal.name, endpoint: fxOriginal.endpoint,
        rootStatus: root.status, vnextStatus: 0,
        label: 'route-missing',
        diffs: [{ layer: 'status', label: 'route-missing', detail: `vnext fetch error: ${(err as Error).message}` }],
      })
      continue
    }

    if (fxOriginal.name === 'responses-basic-non-stream' && root.status < 400) {
      const rb = root.body as { id?: string } | undefined
      if (rb?.id) {
        vars.PREV_RESPONSE_ID = rb.id
        console.error(`[parity]   captured PREV_RESPONSE_ID=${rb.id}`)
      }
    }

    const rep = runFixture(fxOriginal, root, vnext)
    reports.push(rep)
    console.error(`[parity]   → ${rep.label} (root=${rep.rootStatus} vnext=${rep.vnextStatus})`)
  }

  const md = renderReport(reports)
  writeFileSync(REPORT_PATH, md, 'utf8')
  console.error(`[parity] wrote ${REPORT_PATH}`)

  const counts = reports.reduce<Record<string, number>>((acc, r) => {
    acc[r.label] = (acc[r.label] ?? 0) + 1
    return acc
  }, {})
  console.error(`[parity] summary: ${JSON.stringify(counts)}`)
}

if (import.meta.main) {
  await main()
}
