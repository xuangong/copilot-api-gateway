/**
 * Control-plane parity harness (spec 12b).
 *
 * Reads fixtures from ./fixtures/control-plane, topo-sorts by dependsOn,
 * dispatches each to both root (:4141) and vnext (:41415) with the
 * fixture's declared auth mode, captures per-side values for downstream
 * placeholder interpolation, and emits a markdown report + JSON fix-backlog.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type DiffRules, type DiffEntry, type GapLabel,
  diffStatus, diffHeaders, diffJsonBody, aggregateLabel,
} from './lib/diff'

export type AuthMode = 'admin-session' | 'api-key'
export type Side = 'root' | 'vnext'

export interface ControlPlaneFixture {
  name: string
  endpoint: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  auth: AuthMode
  body?: unknown
  expect_status?: number
  capture?: Record<string, string>
  dependsOn?: string[]
  apiKeyFrom?: string
}

export const CONTROL_PLANE_RULES: DiffRules = {
  ignoreKeys: new Set([
    // identity / lifecycle timestamps (camelCase + snake_case forms)
    'id', 'createdAt', 'updatedAt', 'rotatedAt', 'lastUsedAt', 'expiresAt',
    'created_at', 'updated_at', 'rotated_at', 'last_used_at', 'expires_at',
    'exportedAt', 'exported_at', 'timestamp_utc', 'timestampUtc',
    // secrets (vary by-side every time a key is freshly created)
    'secret', 'secretHash', 'key', 'keyHash', 'sessionToken', 'cookie', 'token',
    // owner / user / viewer identifiers (random uuids per side)
    'ownerId', 'userId', 'viewerId', 'granterId', 'githubUserId', 'apiKeyId', 'accountId',
    'owner_id', 'user_id', 'viewer_id', 'granter_id', 'github_user_id', 'api_key_id', 'account_id',
    // metric counters — values wobble request-to-request
    'totalRequests', 'totalTokens', 'totalCost', 'totalLatencyMs',
    'requestCount', 'tokenCount', 'latencyMs', 'latencyP50', 'latencyP95', 'latencyP99',
    'avgLatency', 'avgTokens', 'count', 'sum', 'min', 'max',
    // misc cache/versioning headers in body
    'version', 'etag', 'nonce', 'fingerprint',
  ]),
  headerAllowlist: new Set(['content-type', 'x-request-id', 'transfer-encoding', 'cache-control']),
  strongEnumKeys: new Set(['kind', 'provider', 'enabled', 'role']),
}

const ROOT_BASE = process.env.PARITY_ROOT_BASE ?? 'http://127.0.0.1:4141'
const VNEXT_BASE = process.env.PARITY_VNEXT_BASE ?? 'http://127.0.0.1:41415'
const FIXTURE_DIR = join(import.meta.dir, 'fixtures/control-plane')
const REPORT_PATH = process.env.PARITY_REPORT_PATH
  ?? join(import.meta.dir, '../../docs/superpowers/research/2026-06-25-spec12b-parity-report.md')
const BACKLOG_PATH = process.env.PARITY_BACKLOG_PATH
  ?? join(import.meta.dir, '../../docs/superpowers/research/2026-06-25-spec12b-fix-backlog.md')

export function loadFixtures(dir: string = FIXTURE_DIR): ControlPlaneFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as ControlPlaneFixture)
}

export function topoSort(fixtures: ControlPlaneFixture[]): ControlPlaneFixture[] {
  const byName = new Map(fixtures.map((f) => [f.name, f]))
  const out: ControlPlaneFixture[] = []
  const state = new Map<string, 'pending' | 'visiting' | 'done'>()
  const visit = (name: string) => {
    const s = state.get(name)
    if (s === 'done') return
    if (s === 'visiting') throw new Error(`cycle detected at ${name}`)
    const f = byName.get(name)
    if (!f) throw new Error(`unknown dependsOn target: ${name}`)
    state.set(name, 'visiting')
    for (const d of f.dependsOn ?? []) visit(d)
    state.set(name, 'done')
    out.push(f)
  }
  for (const f of fixtures) visit(f.name)
  return out
}

export interface RunContext {
  captures: Record<string, Record<string, unknown>>
  env: Record<string, string>
}

export function resolvePlaceholders(
  input: unknown,
  ctx: { captures: Record<string, Record<string, unknown>>; env: Record<string, string> },
  side?: Side,
): unknown {
  if (typeof input === 'string') {
    return input.replace(/\$\{(env|capture)\.([^}]+)\}/g, (_, kind, path) => {
      if (kind === 'env') return ctx.env[path] ?? ''
      const [fname, key] = path.split('.')
      const cap = ctx.captures[fname] as Record<string, unknown> | undefined
      if (!cap) return ''
      // Per-side captures live under `${side}_${key}` (e.g. `root_keyId`, `vnext_keyId`).
      // The non-prefixed `key` is the legacy/root value retained for backward-compat tests.
      const sideValue = side ? cap[`${side}_${key}`] : undefined
      const fallback = cap[key]
      return String(sideValue ?? fallback ?? '')
    })
  }
  if (Array.isArray(input)) return input.map((x) => resolvePlaceholders(x, ctx, side))
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .map(([k, v]) => [k, resolvePlaceholders(v, ctx, side)]))
  }
  return input
}

export function buildAuthHeader(
  mode: AuthMode,
  side: Side,
  env: Record<string, string>,
  sideKeys: { root?: string; vnext?: string },
): Record<string, string> {
  if (mode === 'admin-session') {
    const tok = side === 'root' ? env.PARITY_ROOT_ADMIN_TOKEN : env.PARITY_VNEXT_ADMIN_TOKEN
    return { Cookie: `session_token=${tok ?? ''}` }
  }
  const fromCapture = side === 'root' ? sideKeys.root : sideKeys.vnext
  const fallback = side === 'root' ? env.PARITY_ROOT_ADMIN_API_KEY : env.PARITY_VNEXT_ADMIN_API_KEY
  return { Authorization: `Bearer ${fromCapture ?? fallback ?? ''}` }
}

function pickJsonPath(body: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean)
  let cur: unknown = body
  for (const p of parts) {
    if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[p]
    else return undefined
  }
  return cur
}

export interface FixtureReport {
  name: string
  endpoint: string
  method: string
  label: GapLabel | 'dependency-skipped'
  diffs: DiffEntry[]
}

async function dispatch(
  fixture: ControlPlaneFixture, side: Side, base: string,
  ctx: RunContext, sideKeys: { root?: string; vnext?: string },
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const endpoint = resolvePlaceholders(fixture.endpoint, ctx, side) as string
  const body = fixture.body !== undefined ? resolvePlaceholders(fixture.body, ctx, side) : undefined
  const headers: Record<string, string> = {
    ...buildAuthHeader(fixture.auth, side, ctx.env, sideKeys),
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}${endpoint}`, {
    method: fixture.method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const hdrs: Record<string, string> = {}
  res.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = text.length ? JSON.parse(text) : null } catch { /* keep raw */ }
  return { status: res.status, headers: hdrs, body: parsed }
}

export async function runFixture(
  fixture: ControlPlaneFixture, ctx: RunContext,
  skipped: Set<string>,
): Promise<FixtureReport> {
  if (fixture.dependsOn?.some((d) => skipped.has(d))) {
    skipped.add(fixture.name)
    return { name: fixture.name, endpoint: fixture.endpoint, method: fixture.method,
      label: 'dependency-skipped', diffs: [] }
  }

  const sideKeys = fixture.apiKeyFrom
    ? {
      root: ctx.captures[fixture.apiKeyFrom]?.['root_adminApiKey'] as string | undefined,
      vnext: ctx.captures[fixture.apiKeyFrom]?.['vnext_adminApiKey'] as string | undefined,
    }
    : {}

  const [rootR, vnextR] = await Promise.all([
    dispatch(fixture, 'root', ROOT_BASE, ctx, sideKeys),
    dispatch(fixture, 'vnext', VNEXT_BASE, ctx, sideKeys),
  ])

  const diffs: DiffEntry[] = [
    ...diffStatus(rootR.status, vnextR.status),
    ...diffHeaders(rootR.headers, vnextR.headers, CONTROL_PLANE_RULES),
    ...diffJsonBody(rootR.body, vnextR.body, CONTROL_PLANE_RULES),
  ]

  if ((vnextR.status === 404 || vnextR.status === 405) && rootR.status >= 200 && rootR.status < 300) {
    diffs.unshift({ layer: 'status', label: 'route-missing',
      detail: `vnext returned ${vnextR.status} for ${fixture.method} ${fixture.endpoint}` })
  }

  if (fixture.capture) {
    ctx.captures[fixture.name] = {}
    for (const [name, path] of Object.entries(fixture.capture)) {
      const rv = pickJsonPath(rootR.body, path)
      const vv = pickJsonPath(vnextR.body, path)
      ctx.captures[fixture.name][`root_${name}`] = rv
      ctx.captures[fixture.name][`vnext_${name}`] = vv
      ctx.captures[fixture.name][name] = rv
    }
  }

  const label: GapLabel | 'dependency-skipped' = diffs.find((d) => d.label === 'route-missing')
    ? 'route-missing'
    : aggregateLabel(diffs)

  if (fixture.expect_status !== undefined && (rootR.status !== fixture.expect_status || vnextR.status !== fixture.expect_status)) {
    skipped.add(fixture.name)
  }

  return { name: fixture.name, endpoint: fixture.endpoint, method: fixture.method,
    label, diffs }
}

function renderReport(reports: FixtureReport[]): string {
  const counts = reports.reduce<Record<string, number>>((acc, r) => {
    acc[r.label] = (acc[r.label] ?? 0) + 1
    return acc
  }, {})
  const lines: string[] = []
  lines.push('# Spec 12b Control-Plane Parity Report')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Summary')
  for (const k of ['parity', 'cosmetic-diff', 'behavior-gap', 'route-missing', 'dependency-skipped']) {
    lines.push(`- ${k}: ${counts[k] ?? 0}`)
  }
  lines.push('')
  lines.push('## Per-fixture')
  for (const r of reports) {
    lines.push(`### ${r.name} — \`${r.method} ${r.endpoint}\` → **${r.label}**`)
    if (r.diffs.length) {
      for (const d of r.diffs) lines.push(`- [${d.layer}/${d.label}] ${d.detail}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function renderBacklog(reports: FixtureReport[]): string {
  const gaps = reports.filter((r) => r.label === 'behavior-gap' || r.label === 'route-missing')
  const lines: string[] = []
  lines.push('# Spec 12b Fix Backlog')
  lines.push('')
  lines.push(`Open items: ${gaps.length}`)
  lines.push('')
  const clusters = new Map<string, FixtureReport[]>()
  for (const g of gaps) {
    const seg = g.endpoint.split('/')[2] ?? 'other'
    const key = `${g.label}:${seg}`
    if (!clusters.has(key)) clusters.set(key, [])
    clusters.get(key)!.push(g)
  }
  for (const [key, items] of clusters) {
    lines.push(`## Cluster: ${key} (${items.length})`)
    for (const it of items) {
      lines.push(`- **${it.name}** \`${it.method} ${it.endpoint}\``)
      for (const d of it.diffs.slice(0, 5)) lines.push(`  - [${d.layer}] ${d.detail}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const env = process.env as Record<string, string>
  for (const k of ['PARITY_ROOT_ADMIN_TOKEN', 'PARITY_VNEXT_ADMIN_TOKEN']) {
    if (!env[k]) { console.error(`missing env ${k} — run seed-admin-session.ts first`); process.exit(2) }
  }
  const fixtures = topoSort(loadFixtures())
  const ctx: RunContext = { captures: {}, env }
  const skipped = new Set<string>()
  const reports: FixtureReport[] = []
  for (const f of fixtures) {
    const r = await runFixture(f, ctx, skipped)
    console.log(`${r.label.padEnd(20)} ${f.method.padEnd(6)} ${f.endpoint}`)
    reports.push(r)
  }
  writeFileSync(REPORT_PATH, renderReport(reports))
  writeFileSync(BACKLOG_PATH, renderBacklog(reports))
  console.log(`\nreport → ${REPORT_PATH}\nbacklog → ${BACKLOG_PATH}`)
}
