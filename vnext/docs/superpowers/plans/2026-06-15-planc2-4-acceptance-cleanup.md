# Plan C2.4 — 最终收尾（routes.ts 收缩 + 全部 spec §7 验收）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 经过 C2.1/C2.2/C2.3，5 个 chat-flow 端点都已搬到 `chat-flow/<endpoint>/`。本 plan 做最终收敛：把 `routes.ts` 整理到 ≤40 行（仅 Hono mount + auth bridge + 5 个 handler import + 5 个 `dataPlane.post(...)` 行），删尽残余 imports，再用脚本逐条核对 spec §7 的 8 条验收。

**Architecture:** 不新增任何运行时代码；仅做 routes.ts 的静态清理 + 自动化验收脚本。

**Tech Stack:** Bun + bash 验收。

**Spec ref:** `docs/superpowers/specs/2026-06-15-planc2-routes-split-design.md` §7 全部 8 条验收。

**前置:** Plan C2.3 完成（5 个端点全部从 routes.ts 迁出）。

---

## File Structure

修改：
- `packages/gateway/src/data-plane/routes.ts` — 整理 imports + 注释，确保 ≤40 行非空白非注释代码

不新增运行时文件。

---

## Task 1: routes.ts 整理 — 收敛到 ≤40 行

**Files:**
- Modify: `packages/gateway/src/data-plane/routes.ts`

- [ ] **Step 1: 用以下完整内容覆盖 routes.ts**

> 实施者：照抄。任何额外 import 都意味着前序 plan 没拆干净。

```ts
/**
 * Data-plane routes — Hono mount + auth bridge.
 *
 * Each chat-flow endpoint lives under `chat-flow/<endpoint>/{http,serve}.ts`
 * (responses also has snapshot-sidecar.ts + image-generation-shortcut.ts;
 * messages has web-search-shortcut.ts). The shared dispatch orchestrator
 * lives in `chat-flow/shared/dispatch.ts` with no Hono dependency.
 */
import { Hono } from 'hono'
import type { Env } from '../app.ts'
import { modelsRouter, type DataPlaneAuthCtx } from './models/routes.ts'
import { embeddingsRouter } from './embeddings/routes.ts'
import { imagesRouter } from './images/routes.ts'
import { messagesHandler } from './chat-flow/messages/http.ts'
import { chatCompletionsHandler } from './chat-flow/chat-completions/http.ts'
import { responsesHandler } from './chat-flow/responses/http.ts'
import { geminiHandler } from './chat-flow/gemini/http.ts'
import { countTokensHandler } from './chat-flow/count-tokens/http.ts'

export const dataPlane = new Hono<{ Bindings: Env }>()

// Auth bridge — populated by future auth middleware; defaults to empty so
// downstream routers can read c.get('auth') without nullish surprises.
dataPlane.use('*', async (c, next) => {
  if (!c.get('auth' as never)) {
    c.set('auth' as never, {} as DataPlaneAuthCtx)
  }
  await next()
})

dataPlane.route('/', modelsRouter)
dataPlane.route('/', embeddingsRouter)
dataPlane.route('/', imagesRouter)

dataPlane.post('/v1/messages', messagesHandler)
dataPlane.post('/v1/messages/count_tokens', countTokensHandler)
dataPlane.post('/v1/chat/completions', chatCompletionsHandler)
dataPlane.post('/v1/responses', responsesHandler)
dataPlane.post('/v1beta/models/:model{.+}', geminiHandler)
```

- [ ] **Step 2: 数行 — 验证 ≤40 行非空白非注释代码**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  awk '
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*\/\// { next }
    /^[[:space:]]*\/\*/ { in_block=1; next }
    in_block && /\*\// { in_block=0; next }
    in_block { next }
    /^[[:space:]]*\*/ { next }
    { count++ }
    END { print count }
  ' packages/gateway/src/data-plane/routes.ts
```

Expected: `≤ 40`。

- [ ] **Step 3: 跑全量测试**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test 2>&1 | tail -5
```

Expected: pass 数 ≥ C2.3 结尾基线（保持 ≥ 781 pass / ≤4 fail）。

- [ ] **Step 4: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/gateway/src/data-plane/routes.ts
git commit -m "refactor(gateway/data-plane): collapse routes.ts to <=40 lines (mount + handlers only)"
```

---

## Task 2: spec §7.1 — routes.ts 行数验收

- [ ] **Step 1: 执行行数验收脚本**

复用 Task 1 的 awk 计数脚本。要求输出 ≤ 40。若不达标，回到 Task 1 删多余空注释。

---

## Task 3: spec §7.2 — dispatch.ts 行数 + 不 import hono

- [ ] **Step 1: dispatch.ts 行数 ≤ 100**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  awk '
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*\/\// { next }
    /^[[:space:]]*\/\*/ { in_block=1; next }
    in_block && /\*\// { in_block=0; next }
    in_block { next }
    /^[[:space:]]*\*/ { next }
    { count++ }
    END { print count }
  ' packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts
```

Expected: `≤ 100`。

- [ ] **Step 2: dispatch.ts 不 import hono**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  ! grep -E "from ['\"]hono" packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts
```

Expected: grep 无输出（exit code 0 因为 `!`）。

---

## Task 4: spec §7.3 — 各 serve.ts 行数 + 不 import hono

- [ ] **Step 1: 行数检查**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  for f in packages/gateway/src/data-plane/chat-flow/{messages,chat-completions,responses,gemini,count-tokens}/serve.ts; do
    n=$(awk '
      /^[[:space:]]*$/ { next }
      /^[[:space:]]*\/\// { next }
      /^[[:space:]]*\/\*/ { in_block=1; next }
      in_block && /\*\// { in_block=0; next }
      in_block { next }
      /^[[:space:]]*\*/ { next }
      { count++ }
      END { print count }
    ' "$f")
    echo "$f: $n"
  done
```

Expected:
- messages/serve.ts ≤ 60
- chat-completions/serve.ts ≤ 60
- responses/serve.ts ≤ 60
- gemini/serve.ts ≤ 60
- count-tokens/serve.ts ≤ 70

- [ ] **Step 2: 全部 serve.ts 不 import hono**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  ! grep -rE "from ['\"]hono" packages/gateway/src/data-plane/chat-flow/{messages,chat-completions,responses,gemini,count-tokens}/serve.ts
```

Expected: grep 无输出。

---

## Task 5: spec §7.4 — 各 http.ts 行数

- [ ] **Step 1: 行数检查**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  for f in packages/gateway/src/data-plane/chat-flow/{messages,chat-completions,responses,gemini,count-tokens}/http.ts; do
    n=$(awk '
      /^[[:space:]]*$/ { next }
      /^[[:space:]]*\/\// { next }
      /^[[:space:]]*\/\*/ { in_block=1; next }
      in_block && /\*\// { in_block=0; next }
      in_block { next }
      /^[[:space:]]*\*/ { next }
      { count++ }
      END { print count }
    ' "$f")
    echo "$f: $n"
  done
```

Expected: 5 个全部 ≤ 80。

- [ ] **Step 2: 仅 http.ts 与 routes.ts 允许 import hono**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  grep -rE "from ['\"]hono" packages/gateway/src/data-plane/chat-flow/ | \
    grep -vE "(http\.ts|web-search-shortcut\.ts|image-generation-shortcut\.ts|snapshot-sidecar\.ts|gateway-ctx\.ts)"
```

Expected: 无输出。
（说明：除 http.ts 外，shortcut 文件 + sidecar + gateway-ctx 也允许 import Hono `Context` 类型，因为它们直接读 `c.executionCtx` / `c.get('auth')` / `c.req.header` —— 这是 §2 设计的边界。dispatch / serve 不允许。）

---

## Task 6: spec §7.5 + §7.6 — 测试 + tsc 全量

- [ ] **Step 1: 全量测试 + 计数对比**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test 2>&1 | tee /tmp/c2-final.log | tail -10
```

提取 pass / fail：

```bash
grep -E "^[[:space:]]*[0-9]+ (pass|fail)" /tmp/c2-final.log | tail -5
```

Expected:
- pass ≥ 781（基线 768 + dispatch 单测 ≥ 10 + sidecar 单测 ≥ 3）
- fail ≤ 4（dispatch-observability 既存 flake，本拆分不引入新 fail）

- [ ] **Step 2: tsc 全量**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

---

## Task 7: spec §7.7 — routes.ts 残余 import 黑名单

- [ ] **Step 1: 黑名单批量校验**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  for sym in \
    parseMessagesSSEStream parseChatSSEStream parseResponsesSSEStream \
    orchestrator/server-tools/plugins parseTargetSSE mapSourceApiToProviderRequest \
    expandPreviousResponseId savePostTurnSnapshot getResponsesStore \
    runConversationAttempt repackageUpstreamError enumerateBindingCandidates \
    parseModelRouting selectPair getTranslator encodeClientSSE \
    parseMessagesPayload parseChatPayload parseResponsesPayload parseGeminiPayload \
    parseMessagesCountTokensPayload resolveBinding stripUpstreamPin HTTPError \
    PreviousResponseNotFoundError renderPreviousResponseNotFound; do
    if grep -q "$sym" packages/gateway/src/data-plane/routes.ts; then
      echo "LEAK: $sym still in routes.ts"
    fi
  done
```

Expected: 无任何 `LEAK:` 行输出。

如果输出 `LEAK:`，回到对应 plan（C2.2 / C2.3）补漏；通常是某个 inline handler 替换不完整。

---

## Task 8: spec §7.8 — 拆分前后对外行为快验

- [ ] **Step 1: 跑端到端 SDK 集成测试（如有 local server 在跑）**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway && \
  bun run test:integration 2>&1 | tail -20 || \
  echo "skip if local server not running; run 'bun run local' first if integration is desired"
```

Expected: 通过 / skip（视 local server 状态）。

- [ ] **Step 2: 最终提交（如 Tasks 2-7 中产生增量修复，本步合并）**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  git status --short
```

如果工作树干净（前序 task 都已提交），跳过；否则一次性 commit 修复，message 形如：

```bash
git commit -m "chore(gateway/chat-flow): finalize routes.ts split — pass spec C2 §7 acceptance"
```

---

## 终验

- [ ] **Step 1: 列出 chat-flow 树**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  find packages/gateway/src/data-plane/chat-flow -name '*.ts' | sort
```

Expected: 至少包含
- `chat-flow/shared/{dispatch,gateway-ctx,sse-readers,error-wrap}.ts`
- `chat-flow/messages/{http,serve,web-search-shortcut}.ts`
- `chat-flow/chat-completions/{http,serve}.ts`
- `chat-flow/responses/{http,serve,snapshot-sidecar,image-generation-shortcut}.ts`
- `chat-flow/gemini/{http,serve}.ts`
- `chat-flow/count-tokens/{http,serve}.ts`

共 14 个 .ts 源文件。

- [ ] **Step 2: 全 spec §7 一票通过 → 关闭 Plan C2**

如果 Tasks 2–8 全部 ✅ 且 Task 1 commit 已落地，本 plan 完成。可宣告 Plan C2（4 个 sub-plan 全部）closed。

下一步：建议跑一次 `bun run local` + 手动调用各端点冒烟，或直接进入下一个 plan（例如修 dispatch-observability flake / L2 缓存验证）。
