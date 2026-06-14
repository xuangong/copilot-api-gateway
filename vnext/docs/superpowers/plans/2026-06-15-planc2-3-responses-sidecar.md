# Plan C2.3 — `/v1/responses` 抽取 + sidecar 下沉

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/v1/responses` 这个最复杂的端点（带 image-generation 短路、`previous_response_id` 展开 hook、stream/non-stream 双路 sidecar + `waitUntil`）从 `routes.ts` 搬到 `chat-flow/responses/{http,serve,snapshot-sidecar,image-generation-shortcut}.ts`。`mergedInputItems` 不再以闭包捕获方式逃出 dispatch — 显式作为 `serveResponses` 的返回值传给 `http.ts` 的 sidecar 触发逻辑。

**Architecture:** `http.ts` 是 Hono 边界（持有 `c.executionCtx?.waitUntil`，处理 image-gen 短路）。`serve.ts` 调 `dispatch(rawJson, ...)` 并通过 `postParse` hook 展开 `previous_response_id`，把 expanded input items 显式返回。`snapshot-sidecar.ts` 集中 stream/non-stream 双路的 tee/clone + parseSSE + savePostTurnSnapshot 逻辑。

**Tech Stack:** Bun + TypeScript + Hono + CFW ExecutionContext。

**Spec ref:** `docs/superpowers/specs/2026-06-15-planc2-routes-split-design.md` §2.9–§2.11。

**前置:** Plan C2.2 完成（messages / chat-completions / gemini / count-tokens 4 个端点已经迁移；`routes.ts` 仅剩 `/v1/responses` 内联 handler 与 mount 行）。

---

## File Structure

新建：
- `packages/gateway/src/data-plane/chat-flow/responses/image-generation-shortcut.ts`
- `packages/gateway/src/data-plane/chat-flow/responses/serve.ts`
- `packages/gateway/src/data-plane/chat-flow/responses/snapshot-sidecar.ts`
- `packages/gateway/src/data-plane/chat-flow/responses/http.ts`
- `packages/gateway/tests/data-plane/chat-flow/responses/snapshot-sidecar.test.ts` — sidecar 单测（≥3 条）

修改：
- `packages/gateway/src/data-plane/routes.ts` — 删除 `/v1/responses` inline handler，改 import

---

## Task 1: image-generation-shortcut.ts

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/responses/image-generation-shortcut.ts`

- [ ] **Step 1: 创建文件 — 字面搬运 routes.ts:443-456**

```ts
// packages/gateway/src/data-plane/chat-flow/responses/image-generation-shortcut.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { handleResponsesImageGeneration } from '../../orchestrator/server-tools/plugins/image-generation/index.ts'

export async function invokeResponsesImageGenerationShortcut(
  c: Context<{ Bindings: Env }>,
  raw: unknown,
): Promise<Response> {
  const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
  return handleResponsesImageGeneration(
    {
      userId: auth.userId,
      copilot: auth.copilot,
      apiKeyId: auth.apiKeyId,
      requestId: c.req.header('x-request-id') ?? undefined,
      userAgent: c.req.header('user-agent') ?? undefined,
    },
    raw as Parameters<typeof handleResponsesImageGeneration>[1],
  )
}
```

- [ ] **Step 2: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/responses/image-generation-shortcut.ts
git commit -m "feat(gateway/chat-flow): extract responses image-generation-shortcut"
```

---

## Task 2: responses/serve.ts — dispatch + postParse hook + 显式返回 mergedInputItems

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/responses/serve.ts`

- [ ] **Step 1: 创建文件**

```ts
// packages/gateway/src/data-plane/chat-flow/responses/serve.ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseResponsesPayload } from '../../parsers.ts'
import { expandPreviousResponseId } from '../../dispatch/responses-store-bridge.ts'
import { getResponsesStore } from '../../../shared/runtime/responses-store.ts'
import { dispatch, type DispatchObsCtx } from '../shared/dispatch.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'

export interface ResponsesServeArgs {
  raw: unknown
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

export interface ResponsesServeResult {
  response: Response
  /** Post-parse, post-expand input items so the snapshot writer can save the
   *  merged turn history. Empty array when payload.input is missing or
   *  not an array (e.g. parse error short-circuited dispatch before postParse). */
  mergedInputItems: unknown[]
}

export async function serveResponses(args: ResponsesServeArgs): Promise<ResponsesServeResult> {
  const store = getResponsesStore()
  let mergedInputItems: unknown[] = []
  const response = await dispatch(args.raw, {
    parse: (r) => parseResponsesPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'responses',
    errorWrap: jsonErrorWrap,
    auth: args.auth,
    obsCtx: args.obsCtx,
    postParse: async (payload) => {
      await expandPreviousResponseId(
        payload as { previous_response_id?: string | null; input?: unknown },
        store,
        args.auth.apiKeyId ?? null,
      )
      const expanded = (payload as { input?: unknown }).input
      mergedInputItems = Array.isArray(expanded) ? (expanded as unknown[]) : []
    },
  })
  return { response, mergedInputItems }
}
```

- [ ] **Step 2: tsc + 不 import hono 校验**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit \
  && ! grep -E "from ['\"]hono['\"]" packages/gateway/src/data-plane/chat-flow/responses/serve.ts
```

Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/responses/serve.ts
git commit -m "feat(gateway/chat-flow): add responses/serve.ts with explicit mergedInputItems return"
```

---

## Task 3: snapshot-sidecar.ts — stream/non-stream 双路集中

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/responses/snapshot-sidecar.ts`

- [ ] **Step 1: 创建文件 — 把 routes.ts:493-592 的 sidecar 逻辑搬过来，整理成两个公开函数**

```ts
// packages/gateway/src/data-plane/chat-flow/responses/snapshot-sidecar.ts
import type { Context } from 'hono'
import { parseResponsesSSEStream } from '@vnext/provider-copilot'
import { savePostTurnSnapshot } from '../../dispatch/responses-store-bridge.ts'
import { getResponsesStore } from '../../../shared/runtime/responses-store.ts'

/**
 * Sidecar snapshot writers for /v1/responses.
 *
 * Stream branch tees the SSE body, parses upstream events to capture the
 * response id + output items, and persists a post-turn snapshot. Non-stream
 * branch clones the JSON response and reads `id` + `output` from the body.
 *
 * Both branches bind the save promise to the CFW ExecutionContext via
 * `waitUntil` when present so the runtime keeps the worker alive past
 * response settlement; on local Bun there is no executionCtx, so we fall
 * back to fire-and-forget with a swallowed catch (each save IIFE already
 * logs failures).
 */

interface SidecarArgs {
  c: Context
  response: Response
  fallbackModel: string
  apiKeyId: string | null
  requestId: string | null
  mergedInputItems: unknown[]
}

export function attachStreamSidecar(args: SidecarArgs): Response {
  if (!args.response.body) return args.response
  const store = getResponsesStore()
  const [forClient, forSidecar] = args.response.body.tee()
  const { fallbackModel, apiKeyId, requestId, mergedInputItems } = args

  const sidecarPromise = (async () => {
    let responseId: string | null = null
    let model = fallbackModel
    const outputItems: unknown[] = []
    try {
      for await (const evt of parseResponsesSSEStream(forSidecar)) {
        const e = evt as { type?: string; response?: { id?: string; model?: string }; item?: unknown }
        if (e.type === 'response.created' && e.response?.id) {
          responseId = e.response.id
          if (e.response.model) model = e.response.model
        } else if (e.type === 'response.output_item.done' && e.item) {
          outputItems.push(e.item)
        } else if (e.type === 'response.completed') {
          if (e.response?.id && !responseId) responseId = e.response.id
          if (e.response?.model) model = e.response.model
        }
      }
      if (responseId) {
        await savePostTurnSnapshot(store, {
          responseId,
          apiKeyId,
          model,
          inputItems: mergedInputItems,
          outputItems,
        })
      }
    } catch (err) {
      console.warn(JSON.stringify({
        evt: '[responses-snapshot] stream save failed',
        rid: requestId,
        responseId,
        apiKeyId,
        model,
        message: err instanceof Error ? err.message : String(err),
      }))
    }
  })()

  bindToExecutionCtx(args.c, sidecarPromise)
  return new Response(forClient, { status: args.response.status, headers: args.response.headers })
}

export function attachNonStreamSidecar(args: SidecarArgs): Response {
  const store = getResponsesStore()
  const cloned = args.response.clone()
  const { fallbackModel, apiKeyId, requestId, mergedInputItems } = args

  const savePromise = (async () => {
    try {
      const json = await cloned.json() as {
        id?: string
        model?: string
        output?: unknown[]
      }
      // snapshot key === translator-preserved upstream id; bridge never rewrites
      if (typeof json.id === 'string' && Array.isArray(json.output)) {
        await savePostTurnSnapshot(store, {
          responseId: json.id,
          apiKeyId,
          model: typeof json.model === 'string' ? json.model : fallbackModel,
          inputItems: mergedInputItems,
          outputItems: json.output,
        })
      }
    } catch (err) {
      console.warn(JSON.stringify({
        evt: '[responses-snapshot] non-stream save failed',
        rid: requestId,
        apiKeyId,
        model: fallbackModel,
        message: err instanceof Error ? err.message : String(err),
      }))
    }
  })()

  bindToExecutionCtx(args.c, savePromise)
  return args.response
}

function bindToExecutionCtx(c: Context, promise: Promise<void>): void {
  try {
    c.executionCtx?.waitUntil(promise)
  } catch {
    promise.catch(() => { /* swallowed; save IIFE already logs */ })
  }
}
```

- [ ] **Step 2: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/responses/snapshot-sidecar.ts
git commit -m "feat(gateway/chat-flow): extract responses snapshot-sidecar (stream + non-stream)"
```

---

## Task 4: responses/http.ts — 整合 image-gen shortcut + serve + sidecar

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/responses/http.ts`

- [ ] **Step 1: 创建文件**

```ts
// packages/gateway/src/data-plane/chat-flow/responses/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { hasImageGeneration } from '../../orchestrator/server-tools/plugins/image-generation/index.ts'
import { invokeResponsesImageGenerationShortcut } from './image-generation-shortcut.ts'
import { serveResponses } from './serve.ts'
import { attachStreamSidecar, attachNonStreamSidecar } from './snapshot-sidecar.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function responsesHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }

  const rawObj = raw as { tools?: Array<Record<string, unknown>> } | null
  if (rawObj && hasImageGeneration(rawObj.tools as Parameters<typeof hasImageGeneration>[0])) {
    return invokeResponsesImageGenerationShortcut(c, raw)
  }

  const auth = readAuth(c)
  const obsCtx = readObsCtx(c, auth)
  const { response, mergedInputItems } = await serveResponses({ raw, auth, obsCtx })

  if (response.status !== 200) return response
  const ct = response.headers.get('content-type') ?? ''
  const fallbackModel = (raw as { model?: string }).model ?? ''
  const apiKeyId = auth.apiKeyId ?? null
  const requestId = obsCtx.requestId ?? null

  if (ct.includes('text/event-stream') && response.body) {
    return attachStreamSidecar({ c, response, fallbackModel, apiKeyId, requestId, mergedInputItems })
  }
  if (ct.includes('application/json')) {
    return attachNonStreamSidecar({ c, response, fallbackModel, apiKeyId, requestId, mergedInputItems })
  }
  return response
}
```

- [ ] **Step 2: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/responses/http.ts
git commit -m "feat(gateway/chat-flow): add responses/http.ts integrating shortcut + serve + sidecar"
```

---

## Task 5: routes.ts 切换 — 删 inline `/v1/responses` handler

**Files:**
- Modify: `packages/gateway/src/data-plane/routes.ts`

- [ ] **Step 1: 替换 inline handler**

把 `dataPlane.post('/v1/responses', async (c) => { ... })` 整段（约 90 行）删除，替换为：

```ts
// 顶部 imports
import { responsesHandler } from './chat-flow/responses/http.ts'

// 路由
dataPlane.post('/v1/responses', responsesHandler)
```

同时删除以下 `routes.ts` 已无人使用的 imports（确认每一个均不再被任何残留代码引用后再删）：
- `parseResponsesPayload`
- `parseResponsesSSEStream`
- `expandPreviousResponseId`
- `PreviousResponseNotFoundError`（若 `dispatch` 已搬走，则它不再出现在 routes.ts）
- `savePostTurnSnapshot`
- `getResponsesStore`
- `handleResponsesImageGeneration` / `hasImageGeneration`
- `renderPreviousResponseNotFound`（若仅 dispatch 内使用）

- [ ] **Step 2: 跑 responses 全套测试**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  bun test packages/gateway/tests/responses.e2e.test.ts \
           packages/gateway/tests/responses-snapshot-id-roundtrip.test.ts 2>&1 | tail -30
```

Expected: 全部通过；snapshot id 双向 round-trip 测试不退化。

随后跑全量：

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test 2>&1 | tail -5
```

Expected: pass 数不下降（仍允许 4 个既存 dispatch-observability flake）。

- [ ] **Step 3: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/gateway/src/data-plane/routes.ts
git commit -m "refactor(gateway/chat-flow): wire responses handler from chat-flow/responses"
```

---

## Task 6: snapshot-sidecar 单测

**Files:**
- Create: `packages/gateway/tests/data-plane/chat-flow/responses/snapshot-sidecar.test.ts`

- [ ] **Step 1: 写测试 — ≥ 3 条**

参考既有 `packages/gateway/tests/responses-snapshot-id-roundtrip.test.ts` 的 store 初始化方式（`initRepo`、`getResponsesStore`），用最小 fake Hono `Context`（只暴露 `executionCtx?.waitUntil` 字段）。

```ts
// packages/gateway/tests/data-plane/chat-flow/responses/snapshot-sidecar.test.ts
import { test, expect } from 'bun:test'
import {
  attachStreamSidecar,
  attachNonStreamSidecar,
} from '../../../../src/data-plane/chat-flow/responses/snapshot-sidecar.ts'
import { getResponsesStore } from '../../../../src/shared/runtime/responses-store.ts'
// 以及 initRepo / 必要的 store 初始化（参考 responses-snapshot-id-roundtrip.test.ts）

function fakeCtxWithWaitUntil(): { c: { executionCtx?: { waitUntil: (p: Promise<unknown>) => void } }; awaitAll: () => Promise<void> } {
  const pending: Promise<unknown>[] = []
  return {
    c: { executionCtx: { waitUntil: (p) => { pending.push(p) } } },
    awaitAll: async () => { await Promise.all(pending) },
  }
}

function fakeCtxNoExecutionCtx(): { executionCtx?: undefined } {
  return {}
}

test('attachStreamSidecar — tees SSE and persists snapshot via responses-store', async () => {
  // 1. 准备 store（initRepo）
  // 2. 构造 SSE Response：response.created (id=resp_x, model=m) + output_item.done + response.completed
  // 3. attachStreamSidecar({ c: ctx.c, response, fallbackModel: 'm', apiKeyId: 'k', requestId: 'r', mergedInputItems: [...] })
  // 4. 把返回的 Response.body 完整读完（这是给客户端的那一份）
  // 5. await ctx.awaitAll()
  // 6. 断言 store 中存在 responseId='resp_x' 的 snapshot，inputItems / outputItems 与传入一致
  expect(true).toBe(true) // 占位 — 实际实现替换
})

test('attachNonStreamSidecar — clones JSON and persists snapshot', async () => {
  // 1. 构造 JSON Response：{ id: 'resp_y', model: 'mm', output: [{ ... }] }
  // 2. attachNonStreamSidecar(...)
  // 3. 把返回的 response.json() 读完
  // 4. await ctx.awaitAll()
  // 5. 断言 store 中存在 responseId='resp_y' 且 inputItems / outputItems 正确
  expect(true).toBe(true) // 占位
})

test('attachStreamSidecar — falls back to fire-and-forget when executionCtx is absent', async () => {
  // 1. 用 fakeCtxNoExecutionCtx() 作为 c（不会抛、不会阻塞调用方）
  // 2. attachStreamSidecar 必须返回新的 Response（非 throw）
  // 3. 给一些时间让 microtask 跑完，然后断言 store 仍然写入了 snapshot
  expect(true).toBe(true) // 占位
})
```

> **实施者注意**：以上 3 个测试体目前仅为占位 — 实际实现时必须填上完整逻辑（构造 SSE 字节流、初始化 store、断言 store 内容）。参考 `responses-snapshot-id-roundtrip.test.ts` 的 init 模式以避免 Bun 1.3 mock.module 跨文件泄漏（见项目 memory `bun_mock_module_unrestorable.md`）。`getResponsesStore()` 在 sidecar 内部直接调用，所以测试只要先用 `initRepo` 注入真实 SqliteRepo 即可。

- [ ] **Step 2: 跑测试**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/gateway/tests/data-plane/chat-flow/responses/snapshot-sidecar.test.ts 2>&1 | tail -20
```

Expected: 3/3 pass。

- [ ] **Step 3: 全量回归**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test 2>&1 | tail -5
```

Expected: pass 数 = (C2.2 结尾基线) + 3。

- [ ] **Step 4: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/gateway/tests/data-plane/chat-flow/responses/snapshot-sidecar.test.ts
git commit -m "test(gateway/chat-flow): add snapshot-sidecar unit tests (stream + non-stream + no-executionCtx)"
```

---

## 验收（本 plan 结尾）

1. `routes.ts` 已不含 `/v1/responses` 的 inline handler。
2. `chat-flow/responses/serve.ts` 不 import `hono`；`mergedInputItems` 通过 `ResponsesServeResult` 显式返回。
3. `snapshot-sidecar.ts` 把 stream 与 non-stream 两条路集中；`bindToExecutionCtx` 兼容 CFW 与 local Bun。
4. `responses.e2e.test.ts` 与 `responses-snapshot-id-roundtrip.test.ts` 全部通过。
5. snapshot-sidecar 新增 3 条单测全部通过。
6. `bunx tsc --noEmit` PASS。

下一步：执行 Plan C2.4（最终收尾 — `routes.ts` 收缩到 ≤40 行 + spec §7 验收 + dispatch 单测落实 ≥10 条）。
