#!/usr/bin/env bun
/**
 * Spec 12a — Data-Plane Parity Audit harness.
 *
 * Compares root src/ (PORT=4141) and vnext (PORT=41415) across 27 fixtures.
 * Emits structural diff report to vnext/docs/superpowers/research/.
 *
 * Spec: vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------- Types ----------

export type GapLabel = 'parity' | 'cosmetic-diff' | 'behavior-gap' | 'route-missing'

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

export interface DiffEntry {
  layer: 'status' | 'header' | 'body' | 'sse'
  label: GapLabel
  detail: string
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
const FIXTURE_DIR = join(import.meta.dir, 'fixtures/data-plane')
const REPORT_PATH = process.env.PARITY_REPORT_PATH
  ?? join(import.meta.dir, '../../docs/superpowers/research/2026-06-25-spec12a-parity-report.md')

// ---------- Fixture loader ----------

export function loadFixtures(dir: string = FIXTURE_DIR): Fixture[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  return files.map((f) => {
    const raw = readFileSync(join(dir, f), 'utf8')
    const fx = JSON.parse(raw) as Fixture
    // Substitute ${API_KEY} in headers
    for (const [k, v] of Object.entries(fx.headers ?? {})) {
      fx.headers[k] = v.replace(/\$\{API_KEY\}/g, API_KEY)
    }
    return fx
  })
}

// ---------- Diff: status ----------

export function diffStatus(rootStatus: number, vnextStatus: number): DiffEntry[] {
  if (rootStatus === vnextStatus) return []
  return [{
    layer: 'status',
    label: 'behavior-gap',
    detail: `root=${rootStatus} vnext=${vnextStatus}`,
  }]
}

// ---------- Diff: header (allowlist + value masking) ----------

const HEADER_ALLOWLIST = new Set(['content-type', 'x-request-id', 'transfer-encoding', 'cache-control'])

export function maskHeaderValue(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/:\d{2,5}\b/g, ':<port>')
    .replace(/\b\d+\b/g, '<num>')
}

export function diffHeaders(rootHeaders: Record<string, string>, vnextHeaders: Record<string, string>): DiffEntry[] {
  const out: DiffEntry[] = []
  for (const h of HEADER_ALLOWLIST) {
    const r = rootHeaders[h]
    const v = vnextHeaders[h]
    if (r === undefined && v === undefined) continue
    if (r === undefined || v === undefined) {
      out.push({
        layer: 'header',
        label: 'cosmetic-diff',
        detail: `${h}: root=${r ?? '<absent>'} vnext=${v ?? '<absent>'}`,
      })
      continue
    }
    const rm = maskHeaderValue(r)
    const vm = maskHeaderValue(v)
    if (rm !== vm) {
      out.push({
        layer: 'header',
        label: 'cosmetic-diff',
        detail: `${h}: root="${rm}" vnext="${vm}"`,
      })
    }
  }
  return out
}

// ---------- Diff: JSON body ----------

const BODY_IGNORE_KEYS = new Set([
  'id', 'created', 'system_fingerprint', 'x_request_id', 'response_id', 'fingerprint',
])

// Strong fields: if present in either side, must match structurally per spec §3.
// For 'choices[].message.content' we only assert "non-empty on both" (string length > 0).
// For 'usage' we compare KEY SETS only (values ignored — token counts wobble).
function deepDiff(root: unknown, vnext: unknown, path: string, out: DiffEntry[]): void {
  if (root === vnext) return
  if (typeof root !== typeof vnext) {
    out.push({ layer: 'body', label: 'behavior-gap', detail: `${path}: type root=${typeof root} vnext=${typeof vnext}` })
    return
  }
  if (root === null || vnext === null) {
    out.push({ layer: 'body', label: 'behavior-gap', detail: `${path}: root=${root} vnext=${vnext}` })
    return
  }
  if (Array.isArray(root)) {
    if (!Array.isArray(vnext)) {
      out.push({ layer: 'body', label: 'behavior-gap', detail: `${path}: root=array vnext=${typeof vnext}` })
      return
    }
    if (root.length !== vnext.length) {
      out.push({ layer: 'body', label: 'behavior-gap', detail: `${path}: array len root=${root.length} vnext=${vnext.length}` })
      return
    }
    for (let i = 0; i < root.length; i++) deepDiff(root[i], vnext[i], `${path}[${i}]`, out)
    return
  }
  if (typeof root === 'object') {
    const ro = root as Record<string, unknown>
    const vo = vnext as Record<string, unknown>
    const keys = new Set([...Object.keys(ro), ...Object.keys(vo)])
    for (const k of keys) {
      if (BODY_IGNORE_KEYS.has(k)) continue
      const sub = `${path}.${k}`

      // Strong-field special handling
      if (sub.endsWith('.message.content') || sub.endsWith('.content')) {
        const rs = typeof ro[k] === 'string' ? (ro[k] as string).length > 0 : ro[k] != null
        const vs = typeof vo[k] === 'string' ? (vo[k] as string).length > 0 : vo[k] != null
        if (rs !== vs) {
          out.push({ layer: 'body', label: 'behavior-gap', detail: `${sub}: non-empty root=${rs} vnext=${vs}` })
        }
        continue
      }
      if (k === 'usage') {
        const rk = new Set(Object.keys((ro[k] ?? {}) as object))
        const vk = new Set(Object.keys((vo[k] ?? {}) as object))
        const onlyR = [...rk].filter((x) => !vk.has(x))
        const onlyV = [...vk].filter((x) => !rk.has(x))
        if (onlyR.length || onlyV.length) {
          out.push({ layer: 'body', label: 'behavior-gap', detail: `usage keys: onlyRoot=[${onlyR.join(',')}] onlyVnext=[${onlyV.join(',')}]` })
        }
        continue
      }

      deepDiff(ro[k], vo[k], sub, out)
    }
    return
  }
  // primitive mismatch
  out.push({ layer: 'body', label: 'behavior-gap', detail: `${path}: root=${JSON.stringify(root)} vnext=${JSON.stringify(vnext)}` })
}

export function diffJsonBody(rootBody: unknown, vnextBody: unknown): DiffEntry[] {
  const out: DiffEntry[] = []
  deepDiff(rootBody, vnextBody, '$', out)
  return out
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

// ---------- Aggregator ----------

export function aggregateLabel(diffs: DiffEntry[]): GapLabel {
  if (diffs.some((d) => d.label === 'behavior-gap')) return 'behavior-gap'
  if (diffs.some((d) => d.label === 'cosmetic-diff')) return 'cosmetic-diff'
  return 'parity'
}

// ---------- HTTP execution ----------

export async function fetchSide(
  base: string,
  fx: Fixture,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchResult> {
  const url = `${base}${fx.endpoint}`
  const init: RequestInit = {
    method: fx.method,
    headers: fx.headers,
  }
  if (fx.method !== 'GET' && fx.body !== undefined) {
    init.body = typeof fx.body === 'string' ? fx.body : JSON.stringify(fx.body)
    if (!('content-type' in (fx.headers ?? {})) && !('Content-Type' in (fx.headers ?? {}))) {
      init.headers = { ...fx.headers, 'content-type': 'application/json' }
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

// ---------- CLI entry (stub for Part 1) ----------

async function main(): Promise<void> {
  console.error('[parity] harness Part 1 skeleton — real runner wired in Part 3')
  console.error(`[parity] root=${ROOT_BASE} vnext=${VNEXT_BASE} fixtures=${FIXTURE_DIR}`)
  console.error(`[parity] report→${REPORT_PATH}`)
  process.exit(0)
}

if (import.meta.main) {
  await main()
}
