# Spec 12b Plan A — Foundation (diff lib refactor + auth bootstrap)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land prerequisites for 12b harness — (1) extract shared diff lib from 12a so control-plane harness can reuse with its own rules; (2) build a seed script + env contract that gives both root and vNext an admin session + admin API key + target user, all aligned by fixed UUID.

**Architecture:**
- Task 0: pure refactor — pull `maskHeaderValue` / `diffHeaders` / `deepDiff` / `diffJsonBody` / `renderReport` / types out of `vnext/scripts/parity/data-plane-audit.ts` into `vnext/scripts/parity/lib/diff.ts`, **parameterized by `DiffRules`**. `data-plane-audit.ts` becomes a thin caller passing `DATA_PLANE_RULES`. 12a re-run must still emit parity 27/0 (gate A0).
- Task 1: write `vnext/scripts/parity/seed-admin-session.ts` (Bun-native). It opens root sqlite + vNext D1 directly, upserts admin user + target user with fixed UUIDs, writes a `ses_*` session token, creates an admin API key, then echoes env exports to stdout (`PARITY_ROOT_ADMIN_TOKEN`, `PARITY_VNEXT_ADMIN_TOKEN`, `PARITY_ROOT_ADMIN_API_KEY`, `PARITY_VNEXT_ADMIN_API_KEY`, `PARITY_TARGET_USER_ID`, `PARITY_TARGET_USER_EMAIL`). Doc the env contract in `vnext/scripts/parity/README.md`.

**Tech Stack:** Bun, TypeScript, bun:sqlite (root local DB), Cloudflare D1 via wrangler/sqlite file (vNext docker volume), no new deps.

**Scope guard:** This plan does NOT touch fixtures, control-plane harness, or any fix backlog. Those land in Plan B / C.

---

## Task 0: Refactor diff lib out of data-plane-audit.ts

**Files:**
- Create: `vnext/scripts/parity/lib/diff.ts`
- Modify: `vnext/scripts/parity/data-plane-audit.ts` (replace local diff helpers with imports from `./lib/diff`)
- Test (re-run, not new): `vnext/scripts/parity/diff-engine.test.ts` must keep passing untouched

**Reference (existing locations in `data-plane-audit.ts`):**
- `GapLabel` / `DiffEntry` / `FixtureReport` types: lines 16–51
- `HEADER_ALLOWLIST` constant: line 85
- `maskHeaderValue`: line 87
- `diffHeaders`: line 95
- `BODY_IGNORE_KEYS`: line 124
- `deepDiff` (closes over `BODY_IGNORE_KEYS` + hard-coded strong-field handling for `.content` / `usage` / `totalTokens` / `finishReason`): lines 139–200
- `diffJsonBody`: line 201
- `renderReport`: line 402
- `diffStatus`: line 74
- `aggregateLabel`: line 279

- [ ] **Step 1: Write failing test for parameterized diff lib**

Create `vnext/scripts/parity/lib/diff.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { diffJsonBody, diffHeaders, type DiffRules } from './diff'

const CONTROL_PLANE_RULES: DiffRules = {
  ignoreKeys: new Set(['id', 'createdAt']),
  headerAllowlist: new Set(['content-type']),
  strongEnumKeys: new Set(['kind', 'role']),
}

test('diffJsonBody respects rules.ignoreKeys (control-plane shape)', () => {
  const r = diffJsonBody(
    { id: 'a', kind: 'copilot', createdAt: '2026-01-01' },
    { id: 'b', kind: 'copilot', createdAt: '2026-12-31' },
    CONTROL_PLANE_RULES,
  )
  expect(r).toHaveLength(0)
})

test('diffJsonBody flags strong-enum mismatch even when value differs', () => {
  const r = diffJsonBody(
    { kind: 'copilot' },
    { kind: 'azure' },
    CONTROL_PLANE_RULES,
  )
  expect(r.length).toBeGreaterThan(0)
  expect(r[0].label).toBe('behavior-gap')
})

test('diffHeaders honors per-rules allowlist', () => {
  const r = diffHeaders(
    { 'content-type': 'application/json', 'x-foo': 'a' },
    { 'content-type': 'application/json', 'x-foo': 'b' },
    CONTROL_PLANE_RULES,
  )
  expect(r).toHaveLength(0)
})
```

- [ ] **Step 2: Run new test to verify it fails (lib not yet extracted)**

Run: `cd vnext && bun test scripts/parity/lib/diff.test.ts`
Expected: FAIL — `Cannot find module './diff'`

- [ ] **Step 3: Create `vnext/scripts/parity/lib/diff.ts`**

```ts
/**
 * Shared diff lib for parity harnesses (12a data-plane, 12b control-plane).
 * Behavior moved verbatim from data-plane-audit.ts; ignore-key set and
 * strong-enum set are now passed in via DiffRules so each harness can
 * supply its own taxonomy.
 */
export type GapLabel = 'parity' | 'cosmetic-diff' | 'behavior-gap' | 'route-missing'

export interface DiffEntry {
  layer: 'status' | 'header' | 'body' | 'sse'
  label: GapLabel | 'cosmetic-diff'
  detail: string
}

export interface DiffRules {
  ignoreKeys: ReadonlySet<string>
  headerAllowlist: ReadonlySet<string>
  /** Optional: keys whose VALUES must match strictly (e.g. enums like 'kind'). */
  strongEnumKeys?: ReadonlySet<string>
}

export function diffStatus(rootStatus: number, vnextStatus: number): DiffEntry[] {
  if (rootStatus === vnextStatus) return []
  return [{
    layer: 'status', label: 'behavior-gap',
    detail: `status root=${rootStatus} vnext=${vnextStatus}`,
  }]
}

export function maskHeaderValue(value: string): string {
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

export function diffHeaders(
  rootHeaders: Record<string, string>,
  vnextHeaders: Record<string, string>,
  rules: DiffRules,
): DiffEntry[] {
  const out: DiffEntry[] = []
  const keys = new Set([...Object.keys(rootHeaders), ...Object.keys(vnextHeaders)].map((k) => k.toLowerCase()))
  for (const k of keys) {
    if (!rules.headerAllowlist.has(k)) continue
    const rv = rootHeaders[k] ?? rootHeaders[k.toLowerCase()] ?? ''
    const vv = vnextHeaders[k] ?? vnextHeaders[k.toLowerCase()] ?? ''
    if (rv !== vv) {
      out.push({
        layer: 'header', label: 'cosmetic-diff',
        detail: `${k}: root=${maskHeaderValue(rv)} vnext=${maskHeaderValue(vv)}`,
      })
    }
  }
  return out
}

function deepDiff(root: unknown, vnext: unknown, path: string, out: DiffEntry[], rules: DiffRules): void {
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
    for (let i = 0; i < root.length; i++) deepDiff(root[i], vnext[i], `${path}[${i}]`, out, rules)
    return
  }
  if (typeof root === 'object') {
    const ro = root as Record<string, unknown>
    const vo = vnext as Record<string, unknown>
    const keys = new Set([...Object.keys(ro), ...Object.keys(vo)])
    for (const k of keys) {
      if (rules.ignoreKeys.has(k)) continue
      const sub = `${path}.${k}`

      // strong-enum: value must match exactly
      if (rules.strongEnumKeys?.has(k)) {
        if (ro[k] !== vo[k]) {
          out.push({ layer: 'body', label: 'behavior-gap', detail: `${sub}: enum root=${JSON.stringify(ro[k])} vnext=${JSON.stringify(vo[k])}` })
        }
        continue
      }

      // Strong-field special handling (data-plane parity): non-empty check on content,
      // key-set-only on usage. Kept here so 12a behavior is preserved without
      // re-injection — control-plane simply doesn't pass these key names.
      if (sub.endsWith('.message.content') || sub.endsWith('.content')) {
        const rs = typeof ro[k] === 'string' ? (ro[k] as string).length > 0 : ro[k] != null
        const vs = typeof vo[k] === 'string' ? (vo[k] as string).length > 0 : vo[k] != null
        if (rs !== vs) {
          out.push({ layer: 'body', label: 'behavior-gap', detail: `${sub}: non-empty root=${rs} vnext=${vs}` })
        }
        continue
      }
      if (k === 'usage' || k === 'usageMetadata') {
        const rk = new Set(Object.keys((ro[k] ?? {}) as object))
        const vk = new Set(Object.keys((vo[k] ?? {}) as object))
        const onlyR = [...rk].filter((x) => !vk.has(x))
        const onlyV = [...vk].filter((x) => !rk.has(x))
        if (onlyR.length || onlyV.length) {
          out.push({ layer: 'body', label: 'behavior-gap', detail: `${k} keys: onlyRoot=[${onlyR.join(',')}] onlyVnext=[${onlyV.join(',')}]` })
        }
        continue
      }
      if (k === 'totalTokens' || k === 'finishReason') continue

      deepDiff(ro[k], vo[k], sub, out, rules)
    }
    return
  }
  out.push({ layer: 'body', label: 'behavior-gap', detail: `${path}: root=${JSON.stringify(root)} vnext=${JSON.stringify(vnext)}` })
}

export function diffJsonBody(rootBody: unknown, vnextBody: unknown, rules: DiffRules): DiffEntry[] {
  const out: DiffEntry[] = []
  deepDiff(rootBody, vnextBody, '$', out, rules)
  return out
}

export function aggregateLabel(diffs: DiffEntry[]): GapLabel {
  if (diffs.some((d) => d.label === 'behavior-gap')) return 'behavior-gap'
  if (diffs.some((d) => d.label === 'cosmetic-diff')) return 'cosmetic-diff'
  return 'parity'
}
```

- [ ] **Step 4: Run new test to verify it passes**

Run: `cd vnext && bun test scripts/parity/lib/diff.test.ts`
Expected: PASS 3/3

- [ ] **Step 5: Refactor `data-plane-audit.ts` to use lib**

Replace local definitions of `GapLabel` / `DiffEntry` / `maskHeaderValue` / `diffHeaders` / `deepDiff` / `diffJsonBody` / `diffStatus` / `aggregateLabel` / `HEADER_ALLOWLIST` / `BODY_IGNORE_KEYS` with imports + a single `DATA_PLANE_RULES` constant:

```ts
import {
  type DiffRules, type DiffEntry, type GapLabel,
  diffStatus, diffHeaders, diffJsonBody, aggregateLabel, maskHeaderValue,
} from './lib/diff'

const DATA_PLANE_RULES: DiffRules = {
  ignoreKeys: new Set([
    'id', 'created', 'created_at', 'system_fingerprint', 'x_request_id',
    'response_id', 'fingerprint', 'padding', '_upstream',
  ]),
  headerAllowlist: new Set(['content-type', 'x-request-id', 'transfer-encoding', 'cache-control']),
  // data-plane has no strong-enum keys — strong-field handling lives in deepDiff
}

// Re-export for fixture / test callers that previously imported from this file
export { diffStatus, diffHeaders, diffJsonBody, aggregateLabel, maskHeaderValue }
export type { DiffRules, DiffEntry, GapLabel }
```

Update all internal call sites (`diffHeaders(...)`, `diffJsonBody(...)`) to pass `DATA_PLANE_RULES` as third arg.

- [ ] **Step 6: Run existing diff-engine test**

Run: `cd vnext && bun test scripts/parity/diff-engine.test.ts`
Expected: PASS unchanged (it imports from `./data-plane-audit`, which now re-exports)

- [ ] **Step 7: Re-run 12a harness against live root + vnext (Gate A0)**

```bash
# Bring both stacks up first per 12a runbook
bun vnext/scripts/parity/data-plane-audit.ts
```

Expected: report summary still says `parity 27 / behavior-gap 0 / route-missing 0`. If any regression, fix before commit.

- [ ] **Step 8: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/scripts/parity/lib/diff.ts vnext/scripts/parity/lib/diff.test.ts vnext/scripts/parity/data-plane-audit.ts
git commit -m "refactor(vnext/spec12b-T0): extract parameterized diff lib; 12a parity 27/0 preserved"
```

---

## Task 1: Seed script + env contract

**Files:**
- Create: `vnext/scripts/parity/seed-admin-session.ts`
- Create: `vnext/scripts/parity/seed-admin-session.test.ts` (unit-level: pure helper that builds a session row + key row given a deterministic UUID)
- Modify: `vnext/scripts/parity/README.md` (add Bootstrap section documenting the env contract)
- Possibly modify: `docker-compose.vnext.yml` only IF vNext docker entrypoint lacks admin user seed → record as blocker first, fix conditionally

**Constants (fixed UUIDs, identical both sides):**

```
PARITY_ADMIN_USER_ID    = "00000000-0000-4000-a000-0000000000a1"
PARITY_ADMIN_USER_EMAIL = "test@local.dev"
PARITY_TARGET_USER_ID   = "00000000-0000-4000-a000-0000000000b2"
PARITY_TARGET_USER_EMAIL= "parity-target@local.dev"
```

`ses_` prefix on session token is mandatory (root `src/local.ts:416`, vnext `packages/gateway/src/shared/session-auth.ts:60` both route by prefix).

- [ ] **Step 1: Verify vNext docker auto-seeds admin user; record blocker if not**

```bash
# Inspect vnext docker entrypoint / seed
grep -rn "test@local.dev\|seedAdmin\|seed_admin\|admin.*seed" vnext/docker* vnext/packages/gateway/src 2>/dev/null | head -40
```

If vNext does NOT auto-seed admin on container start, create `vnext/docs/superpowers/research/12b-blockers.md`:

```markdown
# Spec 12b Blockers

## B1 (Plan A, Task 1, Step 1) — vNext docker missing admin user seed

`docker-compose.vnext.yml` only sets VNEXT_DEV_* envs; no seed for `test@local.dev`.
Root auto-seeds in `src/local.ts:347`.

**Resolution path:** extend vNext entrypoint OR have `seed-admin-session.ts` insert
the admin user row directly into the D1 sqlite file when it does its session insert.
This plan picks the second option (Step 3) so we don't need to rebuild the docker image.
```

If vNext DOES seed already, skip the blockers file.

- [ ] **Step 2: Write failing unit test for seed helper**

Create `vnext/scripts/parity/seed-admin-session.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { buildSessionToken, buildSeedRows } from './seed-admin-session'

test('session token has ses_ prefix and >32 chars of entropy', () => {
  const tok = buildSessionToken()
  expect(tok.startsWith('ses_')).toBe(true)
  expect(tok.length).toBeGreaterThan(36)
})

test('buildSeedRows emits admin + target user with fixed UUIDs', () => {
  const { users, session, apiKey } = buildSeedRows('ses_test_xyz_______________________________')
  const ids = users.map((u) => u.id).sort()
  expect(ids).toEqual([
    '00000000-0000-4000-a000-0000000000a1',
    '00000000-0000-4000-a000-0000000000b2',
  ])
  expect(session.token).toBe('ses_test_xyz_______________________________')
  expect(session.userId).toBe('00000000-0000-4000-a000-0000000000a1')
  expect(apiKey.ownerId).toBe('00000000-0000-4000-a000-0000000000a1')
  expect(apiKey.key.length).toBeGreaterThan(20)
})
```

- [ ] **Step 3: Run failing test**

Run: `cd vnext && bun test scripts/parity/seed-admin-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `seed-admin-session.ts`**

```ts
/**
 * Seed both root and vnext databases with a deterministic admin user,
 * target user, admin session (ses_-prefixed) and admin API key.
 *
 * Usage:
 *   bun vnext/scripts/parity/seed-admin-session.ts \
 *     --root-db /Users/zhangxian/projects/copilot-api-gateway/.data/local.sqlite \
 *     --vnext-db /Users/zhangxian/projects/copilot-api-gateway/vnext/.data/d1/local.sqlite
 *
 * Echoes env exports to stdout. Pipe to a file or eval to inject into the
 * control-plane harness shell.
 */
import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'

export const PARITY_ADMIN_USER_ID = '00000000-0000-4000-a000-0000000000a1'
export const PARITY_ADMIN_USER_EMAIL = 'test@local.dev'
export const PARITY_TARGET_USER_ID = '00000000-0000-4000-a000-0000000000b2'
export const PARITY_TARGET_USER_EMAIL = 'parity-target@local.dev'

export function buildSessionToken(): string {
  return 'ses_' + randomBytes(24).toString('hex')
}

export function buildApiKey(): string {
  return 'sk_parity_' + randomBytes(16).toString('hex')
}

export interface SeedRows {
  users: Array<{ id: string; email: string; role: 'admin' | 'user' }>
  session: { token: string; userId: string; expiresAt: string }
  apiKey: { id: string; ownerId: string; key: string; name: string }
}

export function buildSeedRows(token: string): SeedRows {
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  return {
    users: [
      { id: PARITY_ADMIN_USER_ID, email: PARITY_ADMIN_USER_EMAIL, role: 'admin' },
      { id: PARITY_TARGET_USER_ID, email: PARITY_TARGET_USER_EMAIL, role: 'user' },
    ],
    session: { token, userId: PARITY_ADMIN_USER_ID, expiresAt },
    apiKey: {
      id: '00000000-0000-4000-a000-0000000000c3',
      ownerId: PARITY_ADMIN_USER_ID,
      key: buildApiKey(),
      name: 'parity-admin-bootstrap',
    },
  }
}

function applyRows(db: Database, rows: SeedRows): void {
  // Schema discovery first: tolerate slight column drift between root + vnext.
  // We INSERT OR REPLACE so re-runs are idempotent.
  for (const u of rows.users) {
    db.run(
      `INSERT OR REPLACE INTO users (id, email, role, createdAt, updatedAt)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
      [u.id, u.email, u.role],
    )
  }
  db.run(
    `INSERT OR REPLACE INTO sessions (token, userId, expiresAt, createdAt)
     VALUES (?, ?, ?, datetime('now'))`,
    [rows.session.token, rows.session.userId, rows.session.expiresAt],
  )
  db.run(
    `INSERT OR REPLACE INTO api_keys (id, ownerId, key, name, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [rows.apiKey.id, rows.apiKey.ownerId, rows.apiKey.key, rows.apiKey.name],
  )
}

function parseArgs(): { rootDb: string; vnextDb: string } {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null)
      .filter((x): x is [string, string] => !!x),
  )
  if (!args['root-db'] || !args['vnext-db']) {
    console.error('usage: --root-db <path> --vnext-db <path>')
    process.exit(2)
  }
  return { rootDb: args['root-db'], vnextDb: args['vnext-db'] }
}

if (import.meta.main) {
  const { rootDb, vnextDb } = parseArgs()

  const rootRows = buildSeedRows(buildSessionToken())
  const vnextRows = buildSeedRows(buildSessionToken())

  const rootHandle = new Database(rootDb)
  const vnextHandle = new Database(vnextDb)
  try {
    applyRows(rootHandle, rootRows)
    applyRows(vnextHandle, vnextRows)
  } finally {
    rootHandle.close()
    vnextHandle.close()
  }

  // env contract — stdout only
  process.stdout.write([
    `export PARITY_ROOT_ADMIN_TOKEN='${rootRows.session.token}'`,
    `export PARITY_VNEXT_ADMIN_TOKEN='${vnextRows.session.token}'`,
    `export PARITY_ROOT_ADMIN_API_KEY='${rootRows.apiKey.key}'`,
    `export PARITY_VNEXT_ADMIN_API_KEY='${vnextRows.apiKey.key}'`,
    `export PARITY_ADMIN_USER_ID='${PARITY_ADMIN_USER_ID}'`,
    `export PARITY_ADMIN_USER_EMAIL='${PARITY_ADMIN_USER_EMAIL}'`,
    `export PARITY_TARGET_USER_ID='${PARITY_TARGET_USER_ID}'`,
    `export PARITY_TARGET_USER_EMAIL='${PARITY_TARGET_USER_EMAIL}'`,
    '',
  ].join('\n'))
}
```

- [ ] **Step 5: Verify unit test now passes**

Run: `cd vnext && bun test scripts/parity/seed-admin-session.test.ts`
Expected: PASS 2/2

- [ ] **Step 6: Smoke-run against live DBs**

Bring up both stacks per 12b spec §2 fixture table, then:

```bash
bun vnext/scripts/parity/seed-admin-session.ts \
  --root-db ./.data/local.sqlite \
  --vnext-db ./vnext/.data/d1/local.sqlite > /tmp/parity-env.sh
cat /tmp/parity-env.sh
```

Expected: 8 `export` lines; both tokens start with `ses_`; both API keys start with `sk_parity_`.

Validate by hitting both stacks:

```bash
source /tmp/parity-env.sh
curl -sS -H "Cookie: session_token=${PARITY_ROOT_ADMIN_TOKEN}" http://127.0.0.1:4141/api/keys -o /dev/null -w '%{http_code}\n'
curl -sS -H "Cookie: session_token=${PARITY_VNEXT_ADMIN_TOKEN}" http://127.0.0.1:41415/api/keys -o /dev/null -w '%{http_code}\n'
```

Expected: both `200`. If either is `401`, the schema column names diverge from the script — inspect with `sqlite3 <db> .schema users sessions api_keys`, adjust `applyRows`, re-run.

If a schema column mismatch is found, fix `applyRows` and re-run Step 6 only. If vNext sqlite file path differs from `./vnext/.data/d1/local.sqlite`, update both the script's default and the README.

- [ ] **Step 7: Update README env contract**

Edit `vnext/scripts/parity/README.md`, add at the end:

```markdown
## Bootstrap (spec 12b)

Before running `control-plane-audit.ts`, seed both DBs and source the env:

```bash
bun vnext/scripts/parity/seed-admin-session.ts \
  --root-db ./.data/local.sqlite \
  --vnext-db ./vnext/.data/d1/local.sqlite > /tmp/parity-env.sh
source /tmp/parity-env.sh
```

Env vars exported:
| name | use |
|------|-----|
| `PARITY_{ROOT,VNEXT}_ADMIN_TOKEN` | `ses_`-prefixed session token (Cookie header) |
| `PARITY_{ROOT,VNEXT}_ADMIN_API_KEY` | Admin API key (Authorization: Bearer) |
| `PARITY_ADMIN_USER_ID` / `_EMAIL` | Seeded admin (fixed UUID, both sides) |
| `PARITY_TARGET_USER_ID` / `_EMAIL` | Second user for assign/share fixtures |

Re-run the script any time tokens expire (~24h).
```

- [ ] **Step 8: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/scripts/parity/seed-admin-session.ts \
        vnext/scripts/parity/seed-admin-session.test.ts \
        vnext/scripts/parity/README.md
# include blockers file if Step 1 created one
[ -f vnext/docs/superpowers/research/12b-blockers.md ] && \
  git add vnext/docs/superpowers/research/12b-blockers.md
git commit -m "feat(vnext/spec12b-T1): seed-admin-session script + env contract (ses_ prefix, fixed UUIDs)"
```

---

## Acceptance gates (Plan A only)

| ID | Gate | Verification |
|----|------|--------------|
| A0 | 12a harness re-run parity = 27/0 after diff lib refactor | Step 7 of Task 0 |
| A1.0 | seed script unit test passes | Step 5 of Task 1 |
| A1.1 | seed script smoke run yields 200/200 from both `/api/keys` (session auth works) | Step 6 of Task 1 |
| A1.2 | env contract documented in README | Step 7 of Task 1 |

Plan B (harness + fixtures) starts only after all four gates green.

## Out of scope (defer to B / C)

- `control-plane-audit.ts` harness implementation
- Any fixture JSON
- API-key auth path validation (covered when `bootstrap-heartbeat-key` fixture runs in Plan B)
- Fixing any control-plane behavior gaps (Plan C)
