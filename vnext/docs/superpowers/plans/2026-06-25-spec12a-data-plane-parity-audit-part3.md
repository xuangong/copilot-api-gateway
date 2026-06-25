# Spec 12a Data-Plane Parity Audit — Implementation Plan (Part 3 / 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal (Part 3):** 把 harness 的 stub `main` 接通真实 dual-fetch,补 multipart 与 `${PREV_RESPONSE_ID}` 替换,跑完 27 条 fixture,生成 markdown report,并完成 A2-A5 的最终验收 + spec §9 的 4-commit layout 收口。

**Architecture (Part 3):** Part 1 留的 `main` 替换为真实 runner:串行迭代 fixture → 先发 root → 拿 response_id 替换 → 发 vnext → `runFixture` 算 diff → 累积 `FixtureReport[]` → `renderReport` 写 markdown。multipart fixture 在 fetchSide 加分支 (FormData)。最后一次性跑全 spec acceptance gate(A2/A3/A4)。

**Tech Stack:** Bun (fetch / FormData / Bun.write)、TypeScript、Docker Compose

**Spec reference:** `vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md` §3 (runner) / §6 A2-A5 / §9 输出物

**前置:** Part 1 三 commit + Part 2 两 commit 已合入;precheck note A1 PASS

---

## File Structure (Part 3)

| 文件 | 变更 | 责任 |
|------|------|------|
| `vnext/scripts/parity/data-plane-audit.ts` | modify | 真 main + multipart 分支 + `${PREV_RESPONSE_ID}` 替换 |
| `vnext/scripts/parity/diff-engine.test.ts` | modify | 追加 multipart fetch 单元测试 |
| `vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md` | create | 真跑生成的 report (spec §9 commit 4) |

---

## Task 6: Multipart + 占位替换 (代码 + 测试)

**Files:**
- Modify: `vnext/scripts/parity/data-plane-audit.ts` (扩展 fetchSide,加 substitutePlaceholders)
- Modify: `vnext/scripts/parity/diff-engine.test.ts` (追加 multipart + placeholder 测试)

- [ ] **Step 1: 扩展 fetchSide 支持 multipart**

在 `vnext/scripts/parity/data-plane-audit.ts` 把现有 `fetchSide` 替换为:

```typescript
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
      // Let fetch set the multipart boundary; remove any pre-set content-type.
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
```

- [ ] **Step 2: 加 `substitutePlaceholders` 函数**

追加:

```typescript
// Substitute ${PREV_RESPONSE_ID} (and future ${...} vars) in a body or string.
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
```

- [ ] **Step 3: 追加单元测试**

在 `vnext/scripts/parity/diff-engine.test.ts` 末尾追加:

```typescript
import { fetchSide, substitutePlaceholders } from './data-plane-audit'

describe('substitutePlaceholders', () => {
  test('replaces in string', () => {
    expect(substitutePlaceholders('id=${X}', { X: 'abc' })).toBe('id=abc')
  })
  test('replaces nested in object/array', () => {
    const r = substitutePlaceholders(
      { previous_response_id: '${PREV_RESPONSE_ID}', items: ['x', '${X}'] },
      { PREV_RESPONSE_ID: 'r_123', X: 'y' },
    )
    expect(r).toEqual({ previous_response_id: 'r_123', items: ['x', 'y'] })
  })
})

describe('fetchSide multipart', () => {
  test('builds FormData and strips content-type', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const fx: Fixture = {
      name: 'mp',
      endpoint: '/v1/x',
      method: 'POST',
      headers: { 'authorization': 'Bearer t', 'content-type': 'application/json' },
      body: {
        multipart: true,
        fields: { model: 'dall-e-2', n: 1 },
        files: { image: { filename: 'x.png', content_type: 'image/png', base64: 'iVBORw0KGgo=' } },
      } as unknown as Record<string, unknown>,
      expect_stream: false,
    }
    const res = await fetchSide('http://x', fx, fakeFetch)
    expect(res.status).toBe(200)
    expect(captured).not.toBeNull()
    expect(captured!.init.body).toBeInstanceOf(FormData)
    const h = captured!.init.headers as Record<string, string>
    expect(h['content-type']).toBeUndefined()
    expect(h['authorization']).toBe('Bearer t')
  })
  test('json body sets content-type when missing', async () => {
    let captured: { init: RequestInit } | null = null
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      captured = { init }
      return new Response('{}', { status: 200, headers: {} })
    }) as unknown as typeof fetch
    const fx: Fixture = {
      name: 'j',
      endpoint: '/x',
      method: 'POST',
      headers: { 'authorization': 'Bearer t' },
      body: { hello: 'world' },
      expect_stream: false,
    }
    await fetchSide('http://x', fx, fakeFetch)
    const h = captured!.init.headers as Record<string, string>
    expect(h['content-type']).toBe('application/json')
  })
})
```

- [ ] **Step 4: 跑测试验证**

Run: `cd vnext && bun test scripts/parity/diff-engine.test.ts`
Expected: 31 passing (27 + 2 placeholder + 2 fetchSide multipart),0 failing。

- [ ] **Step 5: Commit**

```bash
git add vnext/scripts/parity/data-plane-audit.ts vnext/scripts/parity/diff-engine.test.ts
git commit -m "$(cat <<'EOF'
feat(vnext/spec12a): multipart fetch + placeholder substitution

Part 3 task 6: Two harness extensions needed before the live run.

- fetchSide now detects body.multipart=true and builds FormData (decoding
  base64 file blobs), strips any pre-set content-type so fetch picks the
  multipart boundary. JSON path unchanged.
- substitutePlaceholders walks strings/arrays/objects swapping ${VAR}
  tokens. Used for ${PREV_RESPONSE_ID} so responses-stateful-chain can
  reference the id from responses-basic.

4 new unit tests bring the suite to 31 passing.

Spec: vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md §4 (multipart) / §4 (responses stateful)

Generated with Claude Code via Happy

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

## Task 7: 真 main runner (stub 替换)

**Files:**
- Modify: `vnext/scripts/parity/data-plane-audit.ts` (替换 main)

- [ ] **Step 1: 替换 stub main**

把 `vnext/scripts/parity/data-plane-audit.ts` 里现有的 `async function main` 整段替换为:

```typescript
import { writeFileSync } from 'node:fs'

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('[parity] PARITY_API_KEY is required')
    process.exit(2)
  }
  const fixtures = loadFixtures()
  console.error(`[parity] loaded ${fixtures.length} fixtures from ${FIXTURE_DIR}`)
  console.error(`[parity] root=${ROOT_BASE} vnext=${VNEXT_BASE}`)

  // Place stateful chain ordering: ensure responses-basic-non-stream runs
  // before responses-stateful-chain so we can capture the previous id.
  const ordered = [...fixtures].sort((a, b) => {
    const aChain = a.name === 'responses-stateful-chain' ? 1 : 0
    const bChain = b.name === 'responses-stateful-chain' ? 1 : 0
    if (aChain !== bChain) return aChain - bChain
    return a.name.localeCompare(b.name)
  })

  const vars: Record<string, string> = {}
  const reports: FixtureReport[] = []

  for (const fxOriginal of ordered) {
    // Apply placeholder substitution to body and headers
    const fx: Fixture = {
      ...fxOriginal,
      headers: substitutePlaceholders(fxOriginal.headers, vars) as Record<string, string>,
      body: substitutePlaceholders(fxOriginal.body, vars),
    }

    console.error(`[parity] → ${fx.name} (${fx.method} ${fx.endpoint})`)

    let root: FetchResult
    let vnext: FetchResult
    try {
      root = await fetchSide(ROOT_BASE, fx)
    } catch (err) {
      console.error(`[parity]   root fetch failed: ${(err as Error).message}`)
      reports.push({
        fixture: fx.name, endpoint: fx.endpoint,
        rootStatus: 0, vnextStatus: 0,
        label: 'behavior-gap',
        diffs: [{ layer: 'status', label: 'behavior-gap', detail: `root fetch error: ${(err as Error).message}` }],
      })
      continue
    }
    try {
      vnext = await fetchSide(VNEXT_BASE, fx)
    } catch (err) {
      console.error(`[parity]   vnext fetch failed: ${(err as Error).message}`)
      reports.push({
        fixture: fx.name, endpoint: fx.endpoint,
        rootStatus: root.status, vnextStatus: 0,
        label: 'route-missing',
        diffs: [{ layer: 'status', label: 'route-missing', detail: `vnext fetch error: ${(err as Error).message}` }],
      })
      continue
    }

    // Capture previous_response_id from responses-basic-non-stream (root side authoritative)
    if (fx.name === 'responses-basic-non-stream' && root.status < 400) {
      const rb = root.body as { id?: string } | undefined
      if (rb?.id) {
        vars.PREV_RESPONSE_ID = rb.id
        console.error(`[parity]   captured PREV_RESPONSE_ID=${rb.id}`)
      }
    }

    const rep = runFixture(fx, root, vnext)
    reports.push(rep)
    console.error(`[parity]   → ${rep.label} (root=${rep.rootStatus} vnext=${rep.vnextStatus})`)
  }

  const md = renderReport(reports)
  writeFileSync(REPORT_PATH, md, 'utf8')
  console.error(`[parity] wrote ${REPORT_PATH}`)

  // Summary to stderr
  const counts = reports.reduce<Record<string, number>>((acc, r) => {
    acc[r.label] = (acc[r.label] ?? 0) + 1
    return acc
  }, {})
  console.error(`[parity] summary: ${JSON.stringify(counts)}`)
}
```

注:`writeFileSync` import 放到文件顶部 (与 `readdirSync` 同行),不是在 `main` 内 import。

- [ ] **Step 2: 类型检查**

Run: `cd vnext && bun run --filter '@vibe-llm/gateway' typecheck 2>&1 | tail -5`
注:`vnext/scripts/` 不属于任何 workspace package,直接跑 tsc on the file:

```bash
cd vnext && bunx tsc --noEmit --target esnext --module esnext --moduleResolution bundler --types bun scripts/parity/data-plane-audit.ts
```
Expected: 无错误输出。

- [ ] **Step 3: 跑现有单元测试不回归**

Run: `cd vnext && bun test scripts/parity/diff-engine.test.ts`
Expected: 31 passing。

- [ ] **Step 4: Commit**

```bash
git add vnext/scripts/parity/data-plane-audit.ts
git commit -m "$(cat <<'EOF'
feat(vnext/spec12a): live runner — main wired to dual-fetch + chain capture

Part 3 task 7: Replaces the Part 1 stub main with the real runner.

- Sorts fixtures so responses-basic-non-stream runs before
  responses-stateful-chain; captures the root-side response.id into
  vars.PREV_RESPONSE_ID for the chain fixture to consume via
  substitutePlaceholders.
- Sequential by design (spec §2 env-mutex requirement when GH token shared).
- Per-fixture error isolation: a root-side fetch failure records a
  behavior-gap diff; a vnext-side failure records route-missing rather
  than aborting the whole run.
- Writes the report to PARITY_REPORT_PATH (default
  vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md).

Spec: vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md §3 (harness behavior)

Generated with Claude Code via Happy

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

注:Task 6 + Task 7 在 spec §9 的 commit-layout 中合并为 **commit 3 (harness + fixtures)** 的一部分。本 plan 为可追溯把它们拆成多个小 commit;最终 push 前可用 `git rebase -i` 合并成单 logical commit (见 Task 9 step 5)。

---

## Task 8: 端到端真跑 + 生成 report (A2/A3/A4 验收)

**Files:**
- Create: `vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md` (由 harness 写入)

- [ ] **Step 1: 启动 root server (后台)**

Run:
```bash
(PORT=4141 bun run local > /tmp/spec12a-root-run.log 2>&1 &) && sleep 5
curl -s -o /dev/null -w 'root %{http_code}\n' http://127.0.0.1:4141/v1/models
```
Expected: 200 或 401。

- [ ] **Step 2: 启动 vnext (docker)**

Run:
```bash
docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d
sleep 8
curl -s -o /dev/null -w 'vnext %{http_code}\n' http://127.0.0.1:41415/v1/models
```
Expected: 200 或 401,与 root 一致。

- [ ] **Step 3: 跑 harness (27 fixtures × 2 servers,串行,~6-7 min)**

Run:
```bash
PARITY_API_KEY="$(grep -E '^VNEXT_DEV_GITHUB_TOKEN=' .env.vnext | cut -d= -f2-)" \
  bun run vnext/scripts/parity/data-plane-audit.ts 2>&1 | tee /tmp/spec12a-run.log
```

Expected (A2 gate):
- stderr 包含 27 行 `[parity] → <name>` (无 crash)
- 最后一行 `[parity] summary: {...}` 含四种 label 计数
- 退出码 0
- A3 gate: report 文件存在 (`ls -la vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md`)

- [ ] **Step 4: 验证 A3 (report 结构)**

Run:
```bash
head -40 vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md
```

Expected:
- `# Spec 12a — Data-Plane Parity Report` 标题
- `## Summary` 含 4 行 label 计数表
- `## Per-fixture` 含 27 行
- `## Appendix` 含 27 个 sub-section

Run:
```bash
grep -c '^### ' vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md
```
Expected: 27。

- [ ] **Step 5: 验证 A4 (summary 表)**

Run:
```bash
awk '/^## Summary/,/^## Per-fixture/' vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md
```

Expected: 输出表格,4 行 (parity / cosmetic-diff / behavior-gap / route-missing) 各带数值。数值本身不阻断 (spec §6 A4 解释)。

- [ ] **Step 6: 关停 server (留 vnext 容器,root 关掉)**

Run:
```bash
pkill -f 'bun.*src/local.ts' 2>/dev/null || true
docker compose -f docker-compose.vnext.yml down
```

- [ ] **Step 7: Commit report**

```bash
git add vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md
git commit -m "$(cat <<'EOF'
docs(vnext/spec12a): parity audit report — 27 fixtures

Part 3 task 8: Run output. Harness executed all 27 fixtures against
root (:4141) and vnext (:41415) sequentially per spec §2. Summary table
records counts of parity / cosmetic-diff / behavior-gap / route-missing;
appendix records the full diff for each fixture for follow-up fix-specs.

Acceptance: A2 (27/27 no crash), A3 (markdown parses, per-fixture detail
present), A4 (summary table exists).

Spec: vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md §6 (A2/A3/A4)

Generated with Claude Code via Happy

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

## Task 9: 收口 (A5 commit layout + 推送 vNext)

**Files:** 无新文件;只整理 git history 与远端

- [ ] **Step 1: 列出本 audit 累计的所有 commit**

Run:
```bash
git log --oneline origin/vNext..HEAD -- vnext/scripts/parity vnext/docs/superpowers/specs/2026-06-25-spec12a* vnext/docs/superpowers/plans/2026-06-25-spec12a* vnext/docs/superpowers/research/2026-06-25-spec12a*
```

Expected (按时间正序约 9 个 commit):
1. spec12a spec creation
2. spec12a round-1 review fix
3. spec12a round-2 review fix
4. plan part 1
5. plan part 2
6. plan part 3 (本文件,见 below)
7. harness skeleton (task 1)
8. diff engine (task 2)
9. fetchSide + report writer (task 3)
10. fixtures (task 4)
11. precheck (task 5)
12. multipart + placeholder (task 6)
13. live runner (task 7)
14. parity report (task 8)

注:实际数量取决于 task 6/7 是否合并。

- [ ] **Step 2: 决定是否 squash**

Spec §9 输出物表的 4-commit layout:
- commit 1 = spec (已有,前置 commit `d143807` + 后续 review fixes)
- commit 2 = plan (本 plan 三 part = 3 commit,可保留分 part 也可 squash 成 1)
- commit 3 = harness + fixtures (task 1/2/3/4/6/7 = 6 commit,可 squash 成 1)
- commit 4 = report (task 8 单独)
- 额外: precheck (task 5)、本 plan part 3 commit

**决策:保留分 commit (不 squash)。**理由:每个 commit 描述清晰、可独立回滚;§9 表只是建议骨架,非强制。这与 §6 A5 修订后的措辞 "spec / plan / harness+fixtures / report 按 §9 四 commit 入 repo" 在 logical-commit 层面对齐 (harness+fixtures 是同一逻辑组,即使物理上拆成多个小 commit)。

- [ ] **Step 3: A5 verification — log + 文件存在性**

Run:
```bash
git log --oneline -- vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md | head -5
git log --oneline -- vnext/scripts/parity/ | head -10
git log --oneline -- vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md | head -3
ls vnext/scripts/parity/fixtures/data-plane/*.json | wc -l
```

Expected:
- spec 文件至少 3 个 commit (创建 + 两轮 review)
- harness/fixtures 多个 commit
- report 1 个 commit
- fixture 数 = 27

- [ ] **Step 4: 不 merge main 校验**

Run:
```bash
git branch --show-current
git log --oneline origin/main..HEAD | wc -l
```

Expected:
- 当前分支 = `vNext`
- 与 origin/main 有 diff 但 **不打算 merge** (spec §1 / 用户约束)

- [ ] **Step 5: 推送到 origin/vNext (允许;不 merge main)**

Run:
```bash
git push origin vNext
```

Expected: push 成功,远端 vNext 同步本地 HEAD。

注:依据用户授权 "允许 push vNext 远端,但仍不 merge main"。

- [ ] **Step 6: 更新最终 task 状态 (本 plan 自身)**

无文件改动,仅在 TaskUpdate 中标 12a 全部 task 完成 + 总 12a 完成。

---

## Part 3 Deliverable

完成本 part 后:
- harness 完整可跑 (multipart + 占位 + dual-fetch + chain capture)
- 31 单元测试全 pass
- 27 fixture 真跑完成,生成 parity report
- A1 (Part 2 task 5) / A2 / A3 / A4 / A5 全部验收
- 远端 vNext 已推送,main 未 merge

**Self-review:**

1. **Spec coverage (本 part 范围):**
   - §3 harness behavior (real fetch / SSE handling) → ✅ Task 7
   - §4 multipart (images-edits) → ✅ Task 6 fetchSide multipart 分支
   - §4 stateful chain (`${PREV_RESPONSE_ID}`) → ✅ Task 6 substitute + Task 7 capture
   - §6 A2 (27 无 crash) → ✅ Task 8 step 3
   - §6 A3 (report 解析正确) → ✅ Task 8 step 4
   - §6 A4 (summary 表存在) → ✅ Task 8 step 5
   - §6 A5 (4 commit + 推 vNext + 不 merge main) → ✅ Task 9
   - §9 输出物清单全到位 → ✅
2. **Placeholder scan:** 所有 code/cmd 完整。✅
3. **Type consistency:** `FetchResult / Fixture / FixtureReport / GapLabel / MultipartBody` 在 Part 1-3 中一致;新增 `MultipartBody` 是扩展不是覆盖。✅

---

## 12a 全 plan 跨 part overview

| Part | Tasks | 产出 |
|------|-------|------|
| 1 | 1-3 | harness skeleton + diff engine + report writer + 27 单元测试 |
| 2 | 4-5 | 27 fixture JSON + precheck (A1) |
| 3 | 6-9 | multipart + live runner + report 生成 + A2-A5 |

**总:** 9 task,9-14 commit (取决于是否 squash),~1500 行测试和 fixture 代码。

**下游:** 12a 完成后按 spec §10:
- `behavior-gap + route-missing = 0` → 启动 Spec 12b (control-plane audit)
- 否则 → fix-spec 系列,每次完成 re-run harness 直到清零
- 12a/b/c/d 全清零 → Spec 13 cutover (删 root src/ + vnext 提升根,Roadmap §3 step 7 完成)
