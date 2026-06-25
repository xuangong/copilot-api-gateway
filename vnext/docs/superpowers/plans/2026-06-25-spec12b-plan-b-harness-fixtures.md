# Spec 12b Plan B — Harness + Fixtures + Audit Report

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `control-plane-audit.ts` (Bun harness, 33 endpoints, two auth modes, stateful chains) + ~50 fixtures + run it against live root :4141 and vnext :41415, then emit `2026-06-25-spec12b-parity-report.md` and `2026-06-25-spec12b-fix-backlog.md`.

**Architecture:**
- Plan A delivered the shared diff lib (`lib/diff.ts`) and the env contract (`PARITY_{ROOT,VNEXT}_ADMIN_{TOKEN,API_KEY}`, `PARITY_TARGET_USER_*`). This plan builds on top.
- Harness pattern is parallel to `data-plane-audit.ts`: fixture loader → topological order by `dependsOn` → per-fixture double-dispatch → diff (via `lib/diff.ts` with `CONTROL_PLANE_RULES`) → report writer.
- Two auth modes selected via fixture `auth` field:
  - `admin-session` → `Cookie: session_token=${PARITY_{SIDE}_ADMIN_TOKEN}`
  - `api-key` → `Authorization: Bearer ${capture or env}`
- Two captures per fixture (one per side), independent; diff only compares response shapes, not captured values.
- 5 families × ~10 fixtures each + cleanup/error rows = 50.

**Tech Stack:** Bun, TypeScript, fetch built-in, JSON fixtures in `vnext/scripts/parity/fixtures/control-plane/*.json`.

**Pre-req:** Plan A merged (`lib/diff.ts` + `seed-admin-session.ts` exist).

**Scope guard:** This plan ends at "audit ran, report + fix-backlog committed." Actual fixes are Plan C.

---

## Task 2: Harness skeleton (`control-plane-audit.ts`)

**Files:**
- Create: `vnext/scripts/parity/control-plane-audit.ts`
- Create: `vnext/scripts/parity/control-plane-audit.test.ts`
- Create: `vnext/scripts/parity/fixtures/control-plane/.gitkeep`

- [ ] **Step 1: Failing unit tests for harness helpers**

Create `vnext/scripts/parity/control-plane-audit.test.ts`:

```ts
import { test, expect } from 'bun:test'
import {
  CONTROL_PLANE_RULES, topoSort, resolvePlaceholders, buildAuthHeader,
  type ControlPlaneFixture,
} from './control-plane-audit'

test('CONTROL_PLANE_RULES has the spec §3 ignore set', () => {
  for (const k of ['id', 'createdAt', 'secretHash', 'ownerId', 'totalRequests']) {
    expect(CONTROL_PLANE_RULES.ignoreKeys.has(k)).toBe(true)
  }
  expect(CONTROL_PLANE_RULES.strongEnumKeys?.has('kind')).toBe(true)
})

test('topoSort orders by dependsOn and detects cycles', () => {
  const fixtures: ControlPlaneFixture[] = [
    { name: 'b', endpoint: '/x', method: 'GET', auth: 'admin-session', dependsOn: ['a'] },
    { name: 'a', endpoint: '/x', method: 'GET', auth: 'admin-session' },
  ]
  expect(topoSort(fixtures).map((f) => f.name)).toEqual(['a', 'b'])

  const cyc: ControlPlaneFixture[] = [
    { name: 'a', endpoint: '/x', method: 'GET', auth: 'admin-session', dependsOn: ['b'] },
    { name: 'b', endpoint: '/x', method: 'GET', auth: 'admin-session', dependsOn: ['a'] },
  ]
  expect(() => topoSort(cyc)).toThrow(/cycle/)
})

test('resolvePlaceholders walks ${capture.foo.bar} and ${env.X}', () => {
  const ctx = {
    captures: { 'create-key': { keyId: 'kid_1', key: 'sk_abc' } },
    env: { PARITY_TARGET_USER_ID: 'uid_target' },
  }
  expect(resolvePlaceholders('/api/keys/${capture.create-key.keyId}', ctx))
    .toBe('/api/keys/kid_1')
  expect(resolvePlaceholders({ userId: '${env.PARITY_TARGET_USER_ID}' }, ctx))
    .toEqual({ userId: 'uid_target' })
})

test('buildAuthHeader returns cookie for admin-session and bearer for api-key', () => {
  const env = {
    PARITY_ROOT_ADMIN_TOKEN: 'ses_root',
    PARITY_VNEXT_ADMIN_TOKEN: 'ses_vnext',
    PARITY_ROOT_ADMIN_API_KEY: 'sk_root',
    PARITY_VNEXT_ADMIN_API_KEY: 'sk_vnext',
  }
  expect(buildAuthHeader('admin-session', 'root', env, {}))
    .toEqual({ Cookie: 'session_token=ses_root' })
  expect(buildAuthHeader('api-key', 'vnext', env, {}))
    .toEqual({ Authorization: 'Bearer sk_vnext' })
})

test('buildAuthHeader uses fixture-scoped api-key when capture is present', () => {
  // Used by heartbeat fixture: capture.bootstrap-heartbeat-key.adminApiKey.
  // Format aligns with §7 risk-table: dashboard chain owns its own admin key.
  const env = { PARITY_ROOT_ADMIN_API_KEY: 'sk_root_fallback' }
  const sideKeys = { root: 'sk_root_from_capture', vnext: 'sk_vnext_from_capture' }
  expect(buildAuthHeader('api-key', 'root', env, sideKeys))
    .toEqual({ Authorization: 'Bearer sk_root_from_capture' })
})
```

- [ ] **Step 2: Run failing tests**

Run: `cd vnext && bun test scripts/parity/control-plane-audit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `control-plane-audit.ts`**

```ts
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
  capture?: Record<string, string> // name → JSONPath ($.field)
  dependsOn?: string[]
  /** If auth=api-key, name of an upstream fixture whose capture has `adminApiKey`. */
  apiKeyFrom?: string
}

export const CONTROL_PLANE_RULES: DiffRules = {
  ignoreKeys: new Set([
    'id', 'createdAt', 'updatedAt', 'rotatedAt', 'lastUsedAt', 'expiresAt',
    'secretHash', 'keyHash', 'secret', 'sessionToken', 'cookie',
    'ownerId', 'userId', 'viewerId', 'granterId', 'githubUserId', 'apiKeyId', 'accountId',
    'totalRequests', 'totalTokens', 'totalCost', 'totalLatencyMs',
    'requestCount', 'tokenCount', 'latencyMs', 'latencyP50', 'latencyP95', 'latencyP99',
    'avgLatency', 'avgTokens', 'count', 'sum', 'min', 'max',
    'version', 'etag', 'nonce', 'fingerprint',
  ]),
  headerAllowlist: new Set(['content-type', 'x-request-id', 'transfer-encoding', 'cache-control']),
  strongEnumKeys: new Set(['kind', 'provider', 'status', 'enabled', 'role', 'scope']),
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
  /** Per-fixture per-side captures: captures[name][side][captureKey] = value */
  captures: Record<string, Record<string, unknown>>
  env: Record<string, string>
}

export function resolvePlaceholders(input: unknown, ctx: { captures: Record<string, Record<string, unknown>>; env: Record<string, string> }): unknown {
  if (typeof input === 'string') {
    return input.replace(/\$\{(env|capture)\.([^}]+)\}/g, (_, kind, path) => {
      if (kind === 'env') return ctx.env[path] ?? ''
      const [fname, key] = path.split('.')
      const cap = ctx.captures[fname] as Record<string, unknown> | undefined
      return String(cap?.[key] ?? '')
    })
  }
  if (Array.isArray(input)) return input.map((x) => resolvePlaceholders(x, ctx))
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .map(([k, v]) => [k, resolvePlaceholders(v, ctx)]))
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
  // api-key: prefer per-side capture (heartbeat chain), fallback to admin env key
  const fromCapture = side === 'root' ? sideKeys.root : sideKeys.vnext
  const fallback = side === 'root' ? env.PARITY_ROOT_ADMIN_API_KEY : env.PARITY_VNEXT_ADMIN_API_KEY
  return { Authorization: `Bearer ${fromCapture ?? fallback ?? ''}` }
}

function pickJsonPath(body: unknown, path: string): unknown {
  // Minimal $.foo / $.foo.bar — fixtures never need indices.
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
  const endpoint = resolvePlaceholders(fixture.endpoint, ctx) as string
  const body = fixture.body !== undefined ? resolvePlaceholders(fixture.body, ctx) : undefined
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

  // resolve per-side bootstrap api keys (heartbeat chain)
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

  // Detect vnext route-missing: 404/405 only on vnext and root is 2xx.
  if ((vnextR.status === 404 || vnextR.status === 405) && rootR.status >= 200 && rootR.status < 300) {
    diffs.unshift({ layer: 'status', label: 'route-missing',
      detail: `vnext returned ${vnextR.status} for ${fixture.method} ${fixture.endpoint}` })
  }

  // Capture per side (independent — see spec §3)
  if (fixture.capture) {
    ctx.captures[fixture.name] = {}
    for (const [name, path] of Object.entries(fixture.capture)) {
      const rv = pickJsonPath(rootR.body, path)
      const vv = pickJsonPath(vnextR.body, path)
      ctx.captures[fixture.name][`root_${name}`] = rv
      ctx.captures[fixture.name][`vnext_${name}`] = vv
      ctx.captures[fixture.name][name] = rv // default: root value for shell display
    }
  }

  const label = diffs.find((d) => d.label === 'route-missing')
    ? 'route-missing'
    : aggregateLabel(diffs)

  // expect_status violation on either side → behavior-gap
  if (fixture.expect_status !== undefined && (rootR.status !== fixture.expect_status || vnextR.status !== fixture.expect_status)) {
    skipped.add(fixture.name) // dependents skip — we don't trust capture
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
  // Cluster heuristic: route-missing first, then behavior-gap by endpoint prefix.
  const clusters = new Map<string, FixtureReport[]>()
  for (const g of gaps) {
    const seg = g.endpoint.split('/')[2] ?? 'other' // /api/<seg>/...
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
```

- [ ] **Step 4: Run unit tests, expect PASS**

Run: `cd vnext && bun test scripts/parity/control-plane-audit.test.ts`
Expected: 5/5 PASS.

- [ ] **Step 5: Commit harness skeleton**

```bash
git add vnext/scripts/parity/control-plane-audit.ts \
        vnext/scripts/parity/control-plane-audit.test.ts \
        vnext/scripts/parity/fixtures/control-plane/.gitkeep
git commit -m "feat(vnext/spec12b-T2): control-plane harness skeleton (topo, auth modes, diff rules)"
```

---

## Task 3: Fixtures — api-keys family (11 base + cleanup + errors)

**Files (each ≤ 30 lines JSON):**
- `fixtures/control-plane/0100-create-key.json`
- `0101-get-key.json`, `0102-patch-key.json`, `0103-rotate-key.json`,
- `0104-list-keys.json`, `0105-get-web-search-usage.json`,
- `0106-assign-key.json`, `0107-list-assignments.json`, `0108-unassign-key.json`,
- `0109-copy-web-search-from.json`, `0110-delete-key.json`,
- `0111-cleanup-delete-key-twice.json`,
- `0190-create-key-invalid.json`, `0191-rotate-key-invalid.json`, `0192-assign-key-invalid.json`, `0193-copy-from-invalid.json`, `0194-patch-key-invalid.json`

- [ ] **Step 1: Write `0100-create-key.json`**

```json
{
  "name": "create-key",
  "endpoint": "/api/keys",
  "method": "POST",
  "auth": "admin-session",
  "body": { "name": "parity-test-key", "ownerId": null },
  "expect_status": 200,
  "capture": { "keyId": "$.id", "key": "$.key" }
}
```

- [ ] **Step 2: Write remaining api-keys fixtures**

`0101-get-key.json`:
```json
{ "name": "get-key", "endpoint": "/api/keys/${capture.create-key.keyId}", "method": "GET",
  "auth": "admin-session", "dependsOn": ["create-key"], "expect_status": 200 }
```

`0102-patch-key.json`:
```json
{ "name": "patch-key", "endpoint": "/api/keys/${capture.create-key.keyId}", "method": "PATCH",
  "auth": "admin-session", "dependsOn": ["create-key"],
  "body": { "name": "parity-test-key-renamed" }, "expect_status": 200 }
```

`0103-rotate-key.json`:
```json
{ "name": "rotate-key", "endpoint": "/api/keys/${capture.create-key.keyId}/rotate", "method": "POST",
  "auth": "admin-session", "dependsOn": ["create-key", "patch-key"], "expect_status": 200 }
```

`0104-list-keys.json`:
```json
{ "name": "list-keys", "endpoint": "/api/keys", "method": "GET",
  "auth": "admin-session", "dependsOn": ["create-key"], "expect_status": 200 }
```

`0105-get-web-search-usage.json`:
```json
{ "name": "get-web-search-usage",
  "endpoint": "/api/keys/${capture.create-key.keyId}/web-search-usage", "method": "GET",
  "auth": "admin-session", "dependsOn": ["create-key"], "expect_status": 200 }
```

`0106-assign-key.json`:
```json
{ "name": "assign-key", "endpoint": "/api/keys/${capture.create-key.keyId}/assign", "method": "POST",
  "auth": "admin-session", "dependsOn": ["create-key"],
  "body": { "userId": "${env.PARITY_TARGET_USER_ID}" }, "expect_status": 200 }
```

`0107-list-assignments.json`:
```json
{ "name": "list-assignments", "endpoint": "/api/keys/${capture.create-key.keyId}/assignments",
  "method": "GET", "auth": "admin-session", "dependsOn": ["assign-key"], "expect_status": 200 }
```

`0108-unassign-key.json`:
```json
{ "name": "unassign-key",
  "endpoint": "/api/keys/${capture.create-key.keyId}/assign/${env.PARITY_TARGET_USER_ID}",
  "method": "DELETE", "auth": "admin-session", "dependsOn": ["assign-key", "list-assignments"],
  "expect_status": 200 }
```

`0109-copy-web-search-from.json`:
```json
{ "name": "copy-web-search-from",
  "endpoint": "/api/keys/${capture.create-key.keyId}/copy-web-search-from/${capture.create-key.keyId}",
  "method": "POST", "auth": "admin-session",
  "dependsOn": ["create-key", "get-web-search-usage"],
  "expect_status": 400,
  "body": {} }
```
(Note: self-copy is intentionally 400 — same fixture for both sides; tests error parity.)

`0110-delete-key.json`:
```json
{ "name": "delete-key", "endpoint": "/api/keys/${capture.create-key.keyId}", "method": "DELETE",
  "auth": "admin-session", "dependsOn": ["unassign-key", "copy-web-search-from"], "expect_status": 200 }
```

`0111-cleanup-delete-key-twice.json`:
```json
{ "name": "cleanup-delete-key-twice", "endpoint": "/api/keys/${capture.create-key.keyId}",
  "method": "DELETE", "auth": "admin-session", "dependsOn": ["delete-key"], "expect_status": 404 }
```

`0190-create-key-invalid.json`:
```json
{ "name": "create-key-invalid", "endpoint": "/api/keys", "method": "POST",
  "auth": "admin-session", "body": { "ownerId": "not-a-uuid" }, "expect_status": 400 }
```

`0191-rotate-key-invalid.json`:
```json
{ "name": "rotate-key-invalid", "endpoint": "/api/keys/does-not-exist/rotate",
  "method": "POST", "auth": "admin-session", "expect_status": 404 }
```

`0192-assign-key-invalid.json`:
```json
{ "name": "assign-key-invalid",
  "endpoint": "/api/keys/${capture.create-key.keyId}/assign",
  "method": "POST", "auth": "admin-session", "dependsOn": ["create-key"],
  "body": { "userId": "${env.PARITY_ADMIN_USER_ID}" },
  "expect_status": 400 }
```

`0193-copy-from-invalid.json`:
```json
{ "name": "copy-from-invalid",
  "endpoint": "/api/keys/does-not-exist/copy-web-search-from/also-not-exist",
  "method": "POST", "auth": "admin-session", "body": {}, "expect_status": 404 }
```

`0194-patch-key-invalid.json`:
```json
{ "name": "patch-key-invalid", "endpoint": "/api/keys/does-not-exist", "method": "PATCH",
  "auth": "admin-session", "body": { "name": "x" }, "expect_status": 404 }
```

- [ ] **Step 3: Commit**

```bash
git add vnext/scripts/parity/fixtures/control-plane/01*.json
git commit -m "feat(vnext/spec12b-T3): api-keys fixtures (11 base + cleanup + 5 error)"
```

---

## Task 4: Fixtures — upstreams family (8 base + cleanup + 3 errors)

Files prefixed `02xx-`:
- `0200-get-upstream-flags.json` (GET /api/upstream-flags)
- `0201-create-upstream.json` (POST /api/upstreams, body: `{ name, provider: "azure", baseUrl: "https://parity-mock.invalid", apiKey: "fake" }`, capture `upstreamId: $.id`)
- `0202-list-upstreams.json`
- `0203-patch-upstream.json` (rename)
- `0204-test-upstream.json` (expect_status 200 — body shape may show failure detail, ignored fields cover it)
- `0205-list-upstream-models.json` (likely 500/empty list since baseUrl is invalid; expect_status: 200 OR 502 — pick whichever root returns and document)
- `0206-upstream-probe.json` (POST /api/upstream-probe with same fake config)
- `0207-delete-upstream.json`
- `0208-cleanup-delete-upstream-twice.json` (expect_status 404)
- `0290-create-upstream-invalid.json` (missing provider → 400)
- `0291-patch-upstream-invalid.json` (404)
- `0292-upstream-probe-invalid.json` (empty body → 400)

- [ ] **Step 1: Write all 12 fixtures**

Same JSON shape as Task 3. Each file ≤ 30 lines. Use `dependsOn` to chain create → list → patch → test → list-models → delete → cleanup.

- [ ] **Step 2: Commit**

```bash
git add vnext/scripts/parity/fixtures/control-plane/02*.json
git commit -m "feat(vnext/spec12b-T4): upstreams fixtures (8 base + cleanup + 3 error)"
```

---

## Task 5: Fixtures — upstream-accounts + observability-shares (5 base + 2 error)

`03xx-`:
- `0300-list-upstream-accounts.json` — GET /api/upstream-accounts, auth admin-session.

`04xx-`:
- `0400-create-share.json` — POST /api/observability-shares, body `{ viewerEmail: "${env.PARITY_TARGET_USER_EMAIL}", scope: "all" }`, capture `viewerId: $.viewerId`
- `0401-list-granted-by-me.json`
- `0402-list-granted-to-me.json`
- `0403-delete-share.json` — DELETE /api/observability-shares/${capture.create-share.viewerId}
- `0490-create-share-invalid.json` — self-share (use admin email) → 400
- `0491-delete-share-invalid.json` — DELETE non-existent → 404

- [ ] **Step 1: Write fixtures**

- [ ] **Step 2: Commit**

```bash
git add vnext/scripts/parity/fixtures/control-plane/03*.json \
        vnext/scripts/parity/fixtures/control-plane/04*.json
git commit -m "feat(vnext/spec12b-T5): upstream-accounts + observability-shares fixtures"
```

---

## Task 6: Fixtures — dashboard (10 base + 2 error)

`05xx-`:
- `0500-bootstrap-heartbeat-key.json` — POST /api/keys, auth admin-session, body `{ name: "heartbeat-bootstrap", ownerId: null }`, capture `adminApiKey: $.key`. **Independent chain** — no rotate/delete dependents.
- `0501-get-copilot-quota.json` — GET /api/copilot-quota, auth admin-session
- `0502-get-admin-copilot-quota.json` — GET /api/admin/copilot-quota/${env.PARITY_ADMIN_USER_ID}, auth admin-session
- `0503-get-token-usage.json`
- `0504-get-latency.json`
- `0505-get-performance.json`
- `0506-get-relays.json`
- `0507-export-data.json` — GET /api/export?redact=1
- `0508-import-data.json` — POST /api/import body `{ keys: [], upstreams: [] }`, expect_status 200
- `0509-heartbeat.json`:
  ```json
  { "name": "heartbeat", "endpoint": "/api/heartbeat", "method": "POST",
    "auth": "api-key", "apiKeyFrom": "bootstrap-heartbeat-key",
    "dependsOn": ["bootstrap-heartbeat-key"],
    "body": { "clientId": "parity-client", "hostname": "parity-host" },
    "expect_status": 200 }
  ```
- `0590-import-invalid.json` — POST /api/import with malformed body → 400
- `0591-heartbeat-invalid.json` — POST /api/heartbeat with empty body → 400, api-key auth

- [ ] **Step 1: Write fixtures**

- [ ] **Step 2: Commit**

```bash
git add vnext/scripts/parity/fixtures/control-plane/05*.json
git commit -m "feat(vnext/spec12b-T6): dashboard fixtures (incl bootstrap-heartbeat-key + api-key chain)"
```

---

## Task 7: Fixture-count sanity check + dry-run

- [ ] **Step 1: Count fixtures**

```bash
ls vnext/scripts/parity/fixtures/control-plane/*.json | wc -l
```

Expected: **50** (api-keys 16 + upstreams 12 + upstream-accounts 1 + shares 6 + dashboard 12 = 47 + ~3 extras tolerated; if off by >2 from 50 either trim error/cleanup rows or add a missing endpoint).

Spec §4 budget = 34 base + 4 cleanup + 12 error = 50. Adjust files to land at 50.

- [ ] **Step 2: Validate JSON syntax**

```bash
for f in vnext/scripts/parity/fixtures/control-plane/*.json; do
  bun -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "BAD: $f"
done
```

Expected: no `BAD:` lines.

- [ ] **Step 3: Dry-run topo sort (no HTTP)**

```bash
bun -e "
import { loadFixtures, topoSort } from './vnext/scripts/parity/control-plane-audit'
const fs = topoSort(loadFixtures())
console.log(fs.map(f => f.name).join('\n'))
console.log('total:', fs.length)
"
```

Expected: 50 lines + `total: 50`, no cycle errors.

---

## Task 8: Live audit run + report commit

- [ ] **Step 1: Bring up both stacks**

```bash
# root
PORT=4141 bun run local &
# vnext
docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d
sleep 5
curl -sS http://127.0.0.1:4141/healthz
curl -sS http://127.0.0.1:41415/healthz
```

Expected: both return 200.

- [ ] **Step 2: Seed env**

```bash
bun vnext/scripts/parity/seed-admin-session.ts \
  --root-db ./.data/local.sqlite \
  --vnext-db ./vnext/.data/d1/local.sqlite > /tmp/parity-12b-env.sh
source /tmp/parity-12b-env.sh
```

- [ ] **Step 3: Run audit**

```bash
bun vnext/scripts/parity/control-plane-audit.ts
```

Expected: prints 50 lines (one per fixture). Report file appears at `vnext/docs/superpowers/research/2026-06-25-spec12b-parity-report.md`. Backlog file at `vnext/docs/superpowers/research/2026-06-25-spec12b-fix-backlog.md`.

- [ ] **Step 4: Sanity-check report**

```bash
head -20 vnext/docs/superpowers/research/2026-06-25-spec12b-parity-report.md
head -40 vnext/docs/superpowers/research/2026-06-25-spec12b-fix-backlog.md
```

Expected: summary section lists 5 labels with integer counts summing to 50. Backlog clusters present (or "Open items: 0" if vnext is already at parity).

- [ ] **Step 5: Commit report**

```bash
git add vnext/docs/superpowers/research/2026-06-25-spec12b-parity-report.md \
        vnext/docs/superpowers/research/2026-06-25-spec12b-fix-backlog.md
git commit -m "docs(vnext/spec12b-T8): initial control-plane parity report + fix backlog"
```

---

## Acceptance gates (Plan B only)

| ID | Gate | Step |
|----|------|------|
| B0 | harness unit tests pass | T2.Step4 |
| B1 | 50 fixtures exist, all JSON valid, topo-sorts | T7.Step1–3 |
| B2 | live audit runs end-to-end without harness crash | T8.Step3 |
| B3 | report + backlog committed | T8.Step5 |

Plan C starts only after B3.

## Out of scope (defer to C)

- Fixing any gap reported in fix-backlog (Plan C iterates per cluster)
- Final parity 0 closure (Plan C, Gate C-final)
