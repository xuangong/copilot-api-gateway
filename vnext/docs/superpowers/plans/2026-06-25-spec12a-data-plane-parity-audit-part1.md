# Spec 12a Data-Plane Parity Audit — Implementation Plan (Part 1 / 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal (Part 1):** 构建 audit harness 的代码骨架 — 单文件 `vnext/scripts/parity/data-plane-audit.ts`,含 fixture loader / dual-fetch / 三层 diff (status / header / JSON body / SSE) / report writer。本 part 不跑真实流量,只通过单元测试验证 diff 引擎正确性。

**Architecture (Part 1):** 单文件 bun-native script,纯函数式 diff 引擎 (`diffStatus`, `diffHeaders`, `diffJsonBody`, `diffSse`),通过 `bun test` 用 inline fixture 字符串覆盖。harness 的 main 入口先 stub 化 (Part 3 接入实际 fetch)。

**Tech Stack:** Bun (test runner + fetch + Bun.file)、TypeScript、内建 Node `node:assert` (备用,优先 bun:test)、SSE 解析手写 (无第三方依赖)

**Spec reference:** `vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md` §3 Harness 工具 / §5 Gap 分类

---

## File Structure (Part 1)

| 文件 | 责任 |
|------|------|
| `vnext/scripts/parity/data-plane-audit.ts` | 单文件 harness:fixture loader + dual-fetch + diff 引擎 + report writer + CLI entry |
| `vnext/scripts/parity/diff-engine.test.ts` | bun:test 单元测试 — 覆盖 4 个 diff 函数的所有 label 分支 (parity / cosmetic-diff / behavior-gap) |
| `vnext/scripts/parity/README.md` | 一页使用说明:如何跑 harness、如何加 fixture、env 变量列表 |

**显式不在 Part 1 范围:** 实际 fixture JSON 文件 (Part 2)、真实跑双起 (Part 3)、report 文件生成 (Part 3 接通)。

---

## Task 1: Harness 骨架与类型定义

**Files:**
- Create: `vnext/scripts/parity/data-plane-audit.ts`
- Create: `vnext/scripts/parity/README.md`

- [ ] **Step 1: 创建目录**

```bash
mkdir -p vnext/scripts/parity/fixtures/data-plane
```

- [ ] **Step 2: 写 harness 骨架 (类型 + CLI stub)**

写入 `vnext/scripts/parity/data-plane-audit.ts`:

```typescript
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
```

- [ ] **Step 3: 写 README**

写入 `vnext/scripts/parity/README.md`:

```markdown
# Data-Plane Parity Harness (Spec 12a)

Compares root `src/` (port 4141) and vnext (port 41415) on the 27-fixture suite
defined in `vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md`.

## Run

```bash
# Prerequisite: start both servers (see spec §2)
PORT=4141 bun run local                                                    # repo root, one shell
docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d     # another shell

# Run audit
PARITY_API_KEY=<gh-token> bun run vnext/scripts/parity/data-plane-audit.ts
```

## Env

| var | default | purpose |
|-----|---------|---------|
| `PARITY_API_KEY` | (empty) | Substituted into fixture headers; must work against BOTH servers |
| `PARITY_ROOT_BASE` | `http://127.0.0.1:4141` | Root server base URL |
| `PARITY_VNEXT_BASE` | `http://127.0.0.1:41415` | vNext server base URL |
| `PARITY_REPORT_PATH` | `vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md` | Output report |

## Fixture format

```json
{
  "name": "chat-completions-basic-non-stream",
  "endpoint": "/v1/chat/completions",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}" },
  "body": { "model": "gpt-4o-mini", "messages": [...], "stream": false },
  "expect_stream": false
}
```

`${API_KEY}` is substituted at load time.

## Diff rules

See spec §3 table. Summary: status strict-equal; headers allowlist-filtered with
value masking; JSON body deep-diff with `id/created/...` ignored; SSE structural
(event name + order + delta type, NOT prose).
```

- [ ] **Step 4: 验证骨架运行**

Run: `bun run vnext/scripts/parity/data-plane-audit.ts`
Expected stderr:
```
[parity] harness Part 1 skeleton — real runner wired in Part 3
[parity] root=http://127.0.0.1:4141 vnext=http://127.0.0.1:41415 fixtures=...
[parity] report→.../2026-06-25-spec12a-parity-report.md
```
Exit 0.

- [ ] **Step 5: Commit**

```bash
git add vnext/scripts/parity/data-plane-audit.ts vnext/scripts/parity/README.md
git commit -m "$(cat <<'EOF'
feat(vnext/spec12a): parity harness skeleton + types + README

Part 1 task 1: Bun-native single-file scaffold for the data-plane parity
audit. Defines Fixture / FetchResult / DiffEntry / FixtureReport types,
fixture loader with ${API_KEY} substitution, env config, and a stub main
that prints the wiring (real runner lands in Part 3).

Spec: vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md

Generated with Claude Code via Happy

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

## Task 2: Diff 引擎 (4 函数) + 单元测试

**Files:**
- Modify: `vnext/scripts/parity/data-plane-audit.ts` (append diff functions)
- Create: `vnext/scripts/parity/diff-engine.test.ts`

### Design notes (重要)

四个 diff 函数对应 spec §3 的四种 layer。每个函数返回 `DiffEntry[]`。空数组 = 完全一致。`FixtureReport.label` 由 `aggregateLabel(diffs)` 派生:

- 任何 `behavior-gap` → `behavior-gap`
- 否则任何 `cosmetic-diff` → `cosmetic-diff`
- 否则 → `parity`
- `route-missing` 由 caller 在 status=404/405 路径单独标 (Task 3)

### Step list

- [ ] **Step 1: 追加 diff 函数到 harness**

在 `vnext/scripts/parity/data-plane-audit.ts` 文件末尾 (`if (import.meta.main)` 之前) 追加:

```typescript
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
```

- [ ] **Step 2: 写单元测试 — status / header**

写入 `vnext/scripts/parity/diff-engine.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test'
import {
  aggregateLabel,
  diffHeaders,
  diffJsonBody,
  diffSse,
  diffStatus,
  maskHeaderValue,
  parseSse,
} from './data-plane-audit'

describe('diffStatus', () => {
  test('equal status returns no diff', () => {
    expect(diffStatus(200, 200)).toEqual([])
  })
  test('different status is behavior-gap', () => {
    const d = diffStatus(200, 500)
    expect(d).toHaveLength(1)
    expect(d[0].label).toBe('behavior-gap')
    expect(d[0].layer).toBe('status')
  })
})

describe('maskHeaderValue', () => {
  test('masks uuid', () => {
    expect(maskHeaderValue('req-12345678-1234-1234-1234-1234567890ab-end'))
      .toContain('<uuid>')
  })
  test('masks port and digits', () => {
    expect(maskHeaderValue('http://127.0.0.1:4141/x/42'))
      .toMatch(/<port>|<num>/)
  })
})

describe('diffHeaders', () => {
  test('matching allowlisted headers → parity', () => {
    const r = { 'content-type': 'application/json', 'x-extra': 'noise' }
    const v = { 'content-type': 'application/json', 'x-other': 'noise' }
    expect(diffHeaders(r, v)).toEqual([])
  })
  test('different content-type → cosmetic-diff', () => {
    const r = { 'content-type': 'application/json' }
    const v = { 'content-type': 'text/plain' }
    const d = diffHeaders(r, v)
    expect(d).toHaveLength(1)
    expect(d[0].label).toBe('cosmetic-diff')
  })
  test('uuid in x-request-id masked equal → no diff', () => {
    const r = { 'x-request-id': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
    const v = { 'x-request-id': 'ffffffff-1111-2222-3333-444444444444' }
    expect(diffHeaders(r, v)).toEqual([])
  })
})
```

- [ ] **Step 3: 跑 test 验证 status/header 测试通过**

Run: `cd vnext && bun test scripts/parity/diff-engine.test.ts`
Expected: 6 passing, 0 failing。

- [ ] **Step 4: 追加 body diff 测试**

在 `vnext/scripts/parity/diff-engine.test.ts` 末尾追加:

```typescript
describe('diffJsonBody', () => {
  test('identical bodies → no diff', () => {
    const a = { model: 'm', choices: [{ message: { role: 'assistant', content: 'hi' } }] }
    const b = { model: 'm', choices: [{ message: { role: 'assistant', content: 'hi' } }] }
    expect(diffJsonBody(a, b)).toEqual([])
  })
  test('ignored fields differ → no diff', () => {
    const a = { id: 'x1', created: 1, model: 'm', system_fingerprint: 'fp_a' }
    const b = { id: 'x2', created: 9, model: 'm', system_fingerprint: 'fp_b' }
    expect(diffJsonBody(a, b)).toEqual([])
  })
  test('strong field model differs → behavior-gap', () => {
    const a = { model: 'gpt-4o-mini' }
    const b = { model: 'gpt-4o' }
    const d = diffJsonBody(a, b)
    expect(d.some((x) => x.label === 'behavior-gap' && x.detail.includes('model'))).toBe(true)
  })
  test('content non-empty on both sides → no diff (prose ignored)', () => {
    const a = { choices: [{ message: { role: 'assistant', content: 'aaaaaaaaaaa' } }] }
    const b = { choices: [{ message: { role: 'assistant', content: 'completely different prose' } }] }
    expect(diffJsonBody(a, b)).toEqual([])
  })
  test('content empty on one side → behavior-gap', () => {
    const a = { choices: [{ message: { role: 'assistant', content: 'hi' } }] }
    const b = { choices: [{ message: { role: 'assistant', content: '' } }] }
    const d = diffJsonBody(a, b)
    expect(d.some((x) => x.label === 'behavior-gap')).toBe(true)
  })
  test('usage key sets match → no diff (values ignored)', () => {
    const a = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    const b = { usage: { prompt_tokens: 99, completion_tokens: 88, total_tokens: 187 } }
    expect(diffJsonBody(a, b)).toEqual([])
  })
  test('usage key missing on one side → behavior-gap', () => {
    const a = { usage: { prompt_tokens: 10, completion_tokens: 5 } }
    const b = { usage: { prompt_tokens: 10 } }
    const d = diffJsonBody(a, b)
    expect(d.some((x) => x.label === 'behavior-gap' && x.detail.includes('usage'))).toBe(true)
  })
})
```

- [ ] **Step 5: 跑 test 验证 body 测试通过**

Run: `cd vnext && bun test scripts/parity/diff-engine.test.ts`
Expected: 13 passing。

- [ ] **Step 6: 追加 SSE diff 测试**

在测试文件末尾追加:

```typescript
describe('parseSse', () => {
  test('parses event + data blocks', () => {
    const raw = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n'
    const msgs = parseSse(raw)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].event).toBe('message_start')
    expect(msgs[1].kind).toBe('text')
  })
  test('classifies [DONE]', () => {
    const msgs = parseSse('data: [DONE]\n\n')
    expect(msgs[0].kind).toBe('done')
  })
})

describe('diffSse', () => {
  test('same structure different prose → parity', () => {
    const r = 'event: x\ndata: {"delta":{"text":"hello world"}}\n\n'
    const v = 'event: x\ndata: {"delta":{"text":"completely different"}}\n\n'
    expect(diffSse(r, v)).toEqual([])
  })
  test('different event sequence → behavior-gap', () => {
    const r = 'event: a\ndata: {}\n\nevent: b\ndata: {}\n\n'
    const v = 'event: a\ndata: {}\n\nevent: c\ndata: {}\n\n'
    const d = diffSse(r, v)
    expect(d.some((x) => x.label === 'behavior-gap')).toBe(true)
  })
  test('different event count → behavior-gap', () => {
    const r = 'event: a\ndata: {}\n\n'
    const v = 'event: a\ndata: {}\n\nevent: b\ndata: {}\n\n'
    const d = diffSse(r, v)
    expect(d.some((x) => x.detail.includes('event count'))).toBe(true)
  })
})

describe('aggregateLabel', () => {
  test('empty diffs → parity', () => {
    expect(aggregateLabel([])).toBe('parity')
  })
  test('only cosmetic → cosmetic-diff', () => {
    expect(aggregateLabel([{ layer: 'header', label: 'cosmetic-diff', detail: '' }])).toBe('cosmetic-diff')
  })
  test('any behavior-gap dominates', () => {
    expect(aggregateLabel([
      { layer: 'header', label: 'cosmetic-diff', detail: '' },
      { layer: 'body', label: 'behavior-gap', detail: '' },
    ])).toBe('behavior-gap')
  })
})
```

- [ ] **Step 7: 跑全套测试**

Run: `cd vnext && bun test scripts/parity/diff-engine.test.ts`
Expected: 21 passing, 0 failing。

- [ ] **Step 8: 跑 workspace-wide test 不回归**

Run: `cd vnext && bun run test`
Expected: framework-purity OK, 总 pass 数 = 1001 (spec 11 baseline) + 21 新增 = 1022,0 failing。

注:若 framework-purity 因 `vnext/scripts/` 不在扫描范围而不触发,只看 bun test 计数。

- [ ] **Step 9: Commit**

```bash
git add vnext/scripts/parity/data-plane-audit.ts vnext/scripts/parity/diff-engine.test.ts
git commit -m "$(cat <<'EOF'
feat(vnext/spec12a): diff engine (status/header/body/sse) + unit tests

Part 1 task 2: Pure-function diff engine for parity audit.

- diffStatus: strict equal
- diffHeaders: allowlist [content-type, x-request-id, transfer-encoding,
  cache-control] with uuid/port/num masking; mismatches → cosmetic-diff
- diffJsonBody: recursive deep-diff; ignores [id, created, system_fingerprint,
  x_request_id, response_id, fingerprint]; strong fields enforce non-empty
  content (prose ignored) and usage key-set equality (values ignored)
- diffSse: parses event/data blocks, classifies delta kind (text / tool_use /
  stop / done / other), diffs event name + order + kind only
- aggregateLabel: behavior-gap > cosmetic-diff > parity precedence

21 unit tests cover all label branches with inline fixtures (no real HTTP).

Spec: vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md §3 / §5

Generated with Claude Code via Happy

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

## Task 3: Dual-fetch + report writer (单元测试覆盖,Part 3 接入真实 server)

**Files:**
- Modify: `vnext/scripts/parity/data-plane-audit.ts` (追加 fetchSide / runFixture / writeReport)
- Modify: `vnext/scripts/parity/diff-engine.test.ts` (追加 report writer 测试)

- [ ] **Step 1: 追加 fetchSide 与 runFixture (含 route-missing 检测)**

在 `vnext/scripts/parity/data-plane-audit.ts` 的 `aggregateLabel` 之后、`async function main` 之前追加:

```typescript
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
```

- [ ] **Step 2: 追加 report writer**

继续追加到同一文件:

```typescript
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
```

- [ ] **Step 3: 追加 runFixture + report 单元测试**

在 `vnext/scripts/parity/diff-engine.test.ts` 末尾追加:

```typescript
import { renderReport, runFixture } from './data-plane-audit'
import type { FetchResult, Fixture } from './data-plane-audit'

const fx: Fixture = {
  name: 't',
  endpoint: '/v1/x',
  method: 'POST',
  headers: {},
  body: {},
  expect_stream: false,
}

function mkResult(status: number, body: unknown, headers: Record<string, string> = {}): FetchResult {
  return { status, headers, body, raw: JSON.stringify(body) }
}

describe('runFixture', () => {
  test('matching → parity', () => {
    const r = runFixture(fx, mkResult(200, { model: 'm' }), mkResult(200, { model: 'm' }))
    expect(r.label).toBe('parity')
    expect(r.diffs).toEqual([])
  })
  test('vnext 404 vs root 200 → route-missing (short-circuits other diffs)', () => {
    const r = runFixture(fx, mkResult(200, { model: 'm' }), mkResult(404, { error: 'no route' }))
    expect(r.label).toBe('route-missing')
    expect(r.diffs).toHaveLength(1)
  })
  test('vnext 405 vs root 200 → route-missing', () => {
    const r = runFixture(fx, mkResult(200, {}), mkResult(405, {}))
    expect(r.label).toBe('route-missing')
  })
  test('both 404 → not route-missing (root also fails, real status diff path)', () => {
    const r = runFixture(fx, mkResult(404, {}), mkResult(404, {}))
    expect(r.label).toBe('parity')
  })
  test('body strong field diff → behavior-gap', () => {
    const r = runFixture(fx, mkResult(200, { model: 'a' }), mkResult(200, { model: 'b' }))
    expect(r.label).toBe('behavior-gap')
  })
})

describe('renderReport', () => {
  test('summary table reflects counts', () => {
    const md = renderReport([
      { fixture: 'a', endpoint: '/x', rootStatus: 200, vnextStatus: 200, label: 'parity', diffs: [] },
      { fixture: 'b', endpoint: '/y', rootStatus: 200, vnextStatus: 200, label: 'cosmetic-diff', diffs: [{ layer: 'header', label: 'cosmetic-diff', detail: 'ct' }] },
      { fixture: 'c', endpoint: '/z', rootStatus: 200, vnextStatus: 500, label: 'behavior-gap', diffs: [{ layer: 'status', label: 'behavior-gap', detail: 'r=200 v=500' }] },
      { fixture: 'd', endpoint: '/w', rootStatus: 200, vnextStatus: 404, label: 'route-missing', diffs: [{ layer: 'status', label: 'route-missing', detail: '...' }] },
    ])
    expect(md).toContain('| parity | 1 |')
    expect(md).toContain('| cosmetic-diff | 1 |')
    expect(md).toContain('| behavior-gap | 1 |')
    expect(md).toContain('| route-missing | 1 |')
    expect(md).toContain('## Appendix')
    expect(md).toContain('### a (`/x`) — parity')
  })
})
```

- [ ] **Step 4: 跑测试验证全套通过**

Run: `cd vnext && bun test scripts/parity/diff-engine.test.ts`
Expected: 27 passing (21 + 5 runFixture + 1 renderReport), 0 failing。

- [ ] **Step 5: 跑 workspace-wide test 不回归**

Run: `cd vnext && bun run test`
Expected: framework-purity OK,bun test 总数 = baseline + 27,0 failing。

- [ ] **Step 6: Commit**

```bash
git add vnext/scripts/parity/data-plane-audit.ts vnext/scripts/parity/diff-engine.test.ts
git commit -m "$(cat <<'EOF'
feat(vnext/spec12a): fetchSide + runFixture (route-missing) + renderReport

Part 1 task 3: HTTP execution wrapper and markdown report writer for the
parity audit.

- fetchSide(base, fx, fetchImpl?): pluggable fetch impl (real for Part 3,
  injectable for tests). Returns parsed JSON for non-stream, raw text for
  SSE. Auto-injects content-type=application/json for POST bodies.
- runFixture(fx, root, vnext): orchestrates the four diff layers; treats
  vnext 404/405 + root <400 as route-missing (short-circuits other diffs
  so a missing route doesn't double-count as body-gap).
- renderReport(reports): markdown with top-of-file summary table (4 label
  counts), per-fixture row table, and full-diff appendix.

6 additional unit tests cover route-missing detection, label aggregation
through runFixture, and renderReport markdown structure.

Spec: vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md §3 / §6 (A3/A4)

Generated with Claude Code via Happy

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

## Part 1 Deliverable

完成本 part 后:
- `vnext/scripts/parity/data-plane-audit.ts` — harness 单文件 (~350 LOC):types / fixture loader / 4 个 diff 函数 / runFixture / renderReport / stub main
- `vnext/scripts/parity/diff-engine.test.ts` — 27 个单元测试
- `vnext/scripts/parity/README.md` — 使用文档
- 三个 commit (task 1/2/3)

**未完成:** 27 条 fixture JSON (Part 2)、real fetch 接入 + 跑双起 + 生成 report (Part 3)。

**Self-review:**

1. **Spec coverage (本 part 范围):**
   - Spec §3 diff rules 四层 (status / header / JSON body / SSE) → ✅ Task 2
   - Spec §3 fixture loader + `${API_KEY}` 替换 → ✅ Task 1
   - Spec §5 四种 label → ✅ Task 2 (parity/cosmetic-diff/behavior-gap) + Task 3 (route-missing)
   - Spec §3 report 结构 (summary 表 + per-fixture diff + appendix) → ✅ Task 3
2. **Placeholder scan:** 所有 code/cmd 都给了完整内容。✅
3. **Type consistency:** `Fixture / FetchResult / DiffEntry / FixtureReport / GapLabel` 五个类型在三个 task 中一致使用。✅

Part 2 (fixture JSON × 27) 与 Part 3 (执行 + 生成 report + 4 commit layout) 在续篇文档。
