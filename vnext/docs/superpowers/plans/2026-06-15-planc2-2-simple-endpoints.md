# Plan C2.2 — 简单端点抽取（messages / chat-completions / gemini / count-tokens）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `routes.ts` 中 4 个不带 sidecar 的 chat-flow 端点搬到 `chat-flow/<endpoint>/{http,serve}.ts`：`/v1/messages`（含 web-search shortcut 拆出）、`/v1/chat/completions`、`/v1beta/models/:model`、`/v1/messages/count_tokens`（独立路径，不走 dispatch）。`routes.ts` 改为只 import 4 个 handler。

**Architecture:** 每个端点目录自带 `http.ts`（Hono 边界）+ `serve.ts`（纯逻辑、不 import `hono`）。messages 额外有 `web-search-shortcut.ts`。`routes.ts` 不再 import 任何业务 helper / parser，仅留 Hono mount + auth bridge + 4 个 handler。

**Tech Stack:** Bun + TypeScript + Hono。

**Spec ref:** `docs/superpowers/specs/2026-06-15-planc2-routes-split-design.md` §2.5–§2.13。

**前置:** Plan C2.1 已落地（`chat-flow/shared/{dispatch,gateway-ctx,sse-readers,error-wrap}.ts` 4 个文件可用，`dispatch` 签名已是 `(rawJson, input)`）。

---

## File Structure

新建：
- `packages/gateway/src/data-plane/chat-flow/messages/{http,serve,web-search-shortcut}.ts`
- `packages/gateway/src/data-plane/chat-flow/chat-completions/{http,serve}.ts`
- `packages/gateway/src/data-plane/chat-flow/gemini/{http,serve}.ts`
- `packages/gateway/src/data-plane/chat-flow/count-tokens/{http,serve}.ts`

修改：
- `packages/gateway/src/data-plane/routes.ts` — 删 4 个端点的内联 handler，改用 import

不动：
- `/v1/responses` handler — 留给 C2.3 处理

---

## Task 1: messages — 抽 web-search-shortcut.ts

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/messages/web-search-shortcut.ts`

- [ ] **Step 1: 创建文件**

```ts
// packages/gateway/src/data-plane/chat-flow/messages/web-search-shortcut.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { handleMessagesWebSearch } from '../../orchestrator/server-tools/plugins/web-search/index.ts'

export async function invokeMessagesWebSearchShortcut(
  c: Context<{ Bindings: Env }>,
  raw: unknown,
): Promise<Response> {
  const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
  if (!auth.copilot?.copilotToken || !auth.githubToken) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'Copilot/GitHub credentials required for web search.' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )
  }
  return handleMessagesWebSearch(
    {
      copilotToken: auth.copilot.copilotToken,
      accountType: auth.copilot.accountType,
      githubToken: auth.githubToken,
      msGroundingKey: auth.msGroundingKey,
      apiKeyId: auth.apiKeyId,
      requestId: c.req.header('x-request-id') ?? undefined,
      userAgent: c.req.header('user-agent') ?? undefined,
    },
    raw as Parameters<typeof handleMessagesWebSearch>[1],
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
git add packages/gateway/src/data-plane/chat-flow/messages/web-search-shortcut.ts
git commit -m "feat(gateway/chat-flow): extract messages web-search-shortcut"
```

---

## Task 2: messages — 创建 serve.ts

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/messages/serve.ts`

- [ ] **Step 1: 创建文件（不 import hono）**

```ts
// packages/gateway/src/data-plane/chat-flow/messages/serve.ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseMessagesPayload } from '../../parsers.ts'
import { dispatch, type DispatchObsCtx } from '../shared/dispatch.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'

export interface MessagesServeArgs {
  raw: unknown
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

export function serveMessages(args: MessagesServeArgs): Promise<Response> {
  return dispatch(args.raw, {
    parse: (r) => parseMessagesPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'messages',
    errorWrap: jsonErrorWrap,
    auth: args.auth,
    obsCtx: args.obsCtx,
  })
}
```

- [ ] **Step 2: 验证 serve.ts 不 import hono**

```bash
grep -E "from ['\"]hono['\"]" packages/gateway/src/data-plane/chat-flow/messages/serve.ts
```

Expected: 无输出。

- [ ] **Step 3: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/messages/serve.ts
git commit -m "feat(gateway/chat-flow): add messages/serve.ts (no hono dep)"
```

---

## Task 3: messages — 创建 http.ts，routes.ts 切换 handler

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/messages/http.ts`
- Modify: `packages/gateway/src/data-plane/routes.ts`

- [ ] **Step 1: 创建 http.ts**

```ts
// packages/gateway/src/data-plane/chat-flow/messages/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { hasWebSearch } from '../../orchestrator/server-tools/plugins/web-search/index.ts'
import { invokeMessagesWebSearchShortcut } from './web-search-shortcut.ts'
import { serveMessages } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function messagesHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }

  if (hasWebSearch(raw as Parameters<typeof hasWebSearch>[0])) {
    return invokeMessagesWebSearchShortcut(c, raw)
  }

  const auth = readAuth(c)
  return serveMessages({ raw, auth, obsCtx: readObsCtx(c, auth) })
}
```

- [ ] **Step 2: routes.ts 切换 — 删除内联 handler，改用 import**

把 `routes.ts` 中 `dataPlane.post('/v1/messages', async (c) => { ... })` 整段删掉（现状大约 lines 296-345 之后会因为 C2.1 已经改过结构而行号不同；定位到对应的 inline handler 整段），替换成：

```ts
// 顶部 imports 区（与 C2.1 后的状态合并）
import { messagesHandler } from './chat-flow/messages/http.ts'
```

并把 inline handler 替换为：

```ts
dataPlane.post('/v1/messages', messagesHandler)
```

同时删掉 `routes.ts` 中已经无人使用的：
- `import { handleMessagesWebSearch, hasWebSearch }` （现在被 http.ts 内吸收）
- `import { parseMessagesPayload }` （只剩 chat / responses / gemini / count-tokens 还在用）

注意：暂时保留 `parseChatPayload`、`parseResponsesPayload`、`parseGeminiPayload`、`parseMessagesCountTokensPayload` —— 这些下面 Task 才会拆。

- [ ] **Step 3: 跑测试**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/gateway/tests/messages.e2e.test.ts packages/gateway/tests 2>&1 | tail -30
```

Expected: pass 数不下降；messages e2e 测试全部通过。

- [ ] **Step 4: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/messages/http.ts packages/gateway/src/data-plane/routes.ts
git commit -m "refactor(gateway/chat-flow): wire messages handler from chat-flow/messages"
```

---

## Task 4: chat-completions — serve.ts

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts`

- [ ] **Step 1: 创建文件**

```ts
// packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseChatPayload } from '../../parsers.ts'
import { dispatch, type DispatchObsCtx } from '../shared/dispatch.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'

export interface ChatCompletionsServeArgs {
  raw: unknown
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

export function serveChatCompletions(args: ChatCompletionsServeArgs): Promise<Response> {
  return dispatch(args.raw, {
    parse: (r) => parseChatPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'chat_completions',
    // Chat Completions has no required max_tokens — give chat→messages a default
    // so the Anthropic upstream contract (which requires max_tokens) is met.
    fallbackMaxOutputTokens: 4096,
    errorWrap: jsonErrorWrap,
    auth: args.auth,
    obsCtx: args.obsCtx,
  })
}
```

- [ ] **Step 2: tsc + 不 import hono 校验**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit \
  && ! grep -E "from ['\"]hono['\"]" packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts
```

Expected: PASS（且 grep 无 hono import）。

- [ ] **Step 3: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts
git commit -m "feat(gateway/chat-flow): add chat-completions/serve.ts"
```

---

## Task 5: chat-completions — http.ts + routes.ts 切换

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/chat-completions/http.ts`
- Modify: `packages/gateway/src/data-plane/routes.ts`

- [ ] **Step 1: 创建 http.ts**

```ts
// packages/gateway/src/data-plane/chat-flow/chat-completions/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveChatCompletions } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function chatCompletionsHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)
  return serveChatCompletions({ raw, auth, obsCtx: readObsCtx(c, auth) })
}
```

- [ ] **Step 2: routes.ts 切换**

把 `dataPlane.post('/v1/chat/completions', ...)` inline handler 整段删掉，改为：

```ts
// 顶部 imports
import { chatCompletionsHandler } from './chat-flow/chat-completions/http.ts'

// 路由声明
dataPlane.post('/v1/chat/completions', chatCompletionsHandler)
```

同时删掉 `import { parseChatPayload }`（如果只在该 inline handler 用过）。

- [ ] **Step 3: 跑 chat e2e**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/gateway/tests/chat.e2e.test.ts 2>&1 | tail -20
```

Expected: 全部通过。

- [ ] **Step 4: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/chat-completions/http.ts packages/gateway/src/data-plane/routes.ts
git commit -m "refactor(gateway/chat-flow): wire chat-completions handler"
```

---

## Task 6: gemini — serve.ts

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/gemini/serve.ts`

- [ ] **Step 1: 创建文件**

```ts
// packages/gateway/src/data-plane/chat-flow/gemini/serve.ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseGeminiPayload } from '../../parsers.ts'
import { dispatch, type DispatchObsCtx } from '../shared/dispatch.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'

export interface GeminiServeArgs {
  raw: unknown
  model: string
  forceStream: boolean
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

export function serveGemini(args: GeminiServeArgs): Promise<Response> {
  return dispatch(args.raw, {
    parse: (r) => parseGeminiPayload(r),
    modelOf: () => args.model,
    // Gemini payload has no top-level model; the translator reads it from
    // TranslateContext.model. Force-stream is decoded from the URL verb.
    forceStream: args.forceStream,
    fallbackMaxOutputTokens: 4096,
    sourceApi: 'gemini',
    errorWrap: jsonErrorWrap,
    auth: args.auth,
    obsCtx: args.obsCtx,
  })
}
```

- [ ] **Step 2: tsc + 不 import hono 校验**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit \
  && ! grep -E "from ['\"]hono['\"]" packages/gateway/src/data-plane/chat-flow/gemini/serve.ts
```

Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/gemini/serve.ts
git commit -m "feat(gateway/chat-flow): add gemini/serve.ts"
```

---

## Task 7: gemini — http.ts + routes.ts 切换

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/gemini/http.ts`
- Modify: `packages/gateway/src/data-plane/routes.ts`

- [ ] **Step 1: 创建 http.ts**

```ts
// packages/gateway/src/data-plane/chat-flow/gemini/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveGemini } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function geminiHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  // Gemini path encodes model + verb: "gemini-1.5-pro:generateContent" or ":streamGenerateContent"
  const rawParam = c.req.param('model')
  const [model, verb] = rawParam.split(':')
  const forceStream = verb === 'streamGenerateContent'

  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)
  return serveGemini({
    raw,
    model: model ?? '',
    forceStream,
    auth,
    obsCtx: readObsCtx(c, auth),
  })
}
```

- [ ] **Step 2: routes.ts 切换**

替换 `dataPlane.post('/v1beta/models/:model{.+}', ...)` 内联 handler：

```ts
// 顶部 imports
import { geminiHandler } from './chat-flow/gemini/http.ts'

// 路由
dataPlane.post('/v1beta/models/:model{.+}', geminiHandler)
```

删除 `import { parseGeminiPayload }`（如果该 import 仅服务于此 handler）。

- [ ] **Step 3: 跑 gemini e2e**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/gateway/tests/gemini.e2e.test.ts 2>&1 | tail -20
```

Expected: 全部通过。

- [ ] **Step 4: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/gemini/http.ts packages/gateway/src/data-plane/routes.ts
git commit -m "refactor(gateway/chat-flow): wire gemini handler"
```

---

## Task 8: count-tokens — serve.ts（独立路径，不走 dispatch）

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/count-tokens/serve.ts`

- [ ] **Step 1: 创建文件 — 字面搬运 routes.ts 中 count_tokens 的核心逻辑**

```ts
// packages/gateway/src/data-plane/chat-flow/count-tokens/serve.ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseMessagesCountTokensPayload } from '../../parsers.ts'
import { resolveBinding, stripUpstreamPin } from '../../routing/binding-resolver.ts'
import { repackageUpstreamError } from '../../errors/repackage.ts'
import { HTTPError } from '@vnext/provider-copilot'
import { jsonErrorWrap } from '../shared/error-wrap.ts'

export interface CountTokensServeArgs {
  raw: unknown
  auth: DataPlaneAuthCtx
  /** Pre-extracted forwarded headers. Caller (http.ts) reads `anthropic-beta`
   *  and `anthropic-version` from c.req.raw.headers and passes them through. */
  forwardedHeaders: Record<string, string>
  /** Forwarded AbortSignal from the inbound Hono request. */
  signal?: AbortSignal
}

export async function serveCountTokens(args: CountTokensServeArgs): Promise<Response> {
  let payload
  try { payload = parseMessagesCountTokensPayload(args.raw) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return jsonErrorWrap(
      e.status ?? 400,
      e.body ?? { type: 'error', error: { type: 'invalid_request_error', message: e.message } },
    )
  }
  stripUpstreamPin(payload as unknown as Record<string, unknown>)

  const binding = await resolveBinding(payload.model, 'messages_count_tokens', {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
  })
  if (!binding) {
    return jsonErrorWrap(404, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `No messages_count_tokens upstream available for model: ${payload.model}. Run GET /v1/models for available ids.`,
      },
    })
  }

  try {
    const headers = new Headers({ 'content-type': 'application/json' })
    for (const [k, v] of Object.entries(args.forwardedHeaders)) headers.set(k, v)
    const pr = await binding.provider.fetch({
      endpoint: 'messages_count_tokens',
      payload,
      headers,
      sourceApi: 'anthropic',
      operationName: 'count tokens',
      flags: { isStreaming: false },
      signal: args.signal,
    })
    const response = new Response(pr.body, { status: pr.status, headers: pr.headers })
    const json = await response.json()
    return Response.json(json, { status: response.status })
  } catch (err) {
    if (err instanceof HTTPError) {
      return await repackageUpstreamError(err.response, 'messages')
    }
    const message = err instanceof Error ? err.message : 'upstream error'
    return jsonErrorWrap(502, { type: 'error', error: { type: 'api_error', message } })
  }
}
```

- [ ] **Step 2: tsc + 不 import hono 校验**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit \
  && ! grep -E "from ['\"]hono['\"]" packages/gateway/src/data-plane/chat-flow/count-tokens/serve.ts
```

Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/count-tokens/serve.ts
git commit -m "feat(gateway/chat-flow): add count-tokens/serve.ts (independent path, no dispatch)"
```

---

## Task 9: count-tokens — http.ts + routes.ts 切换

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/count-tokens/http.ts`
- Modify: `packages/gateway/src/data-plane/routes.ts`

- [ ] **Step 1: 创建 http.ts**

```ts
// packages/gateway/src/data-plane/chat-flow/count-tokens/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveCountTokens } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth } from '../shared/gateway-ctx.ts'

export async function countTokensHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }

  const reqHeaders = c.req.raw.headers
  const forwardedHeaders: Record<string, string> = {}
  const beta = reqHeaders.get('anthropic-beta')
  if (beta) forwardedHeaders['anthropic-beta'] = beta
  const version = reqHeaders.get('anthropic-version')
  if (version) forwardedHeaders['anthropic-version'] = version

  return serveCountTokens({
    raw,
    auth: readAuth(c),
    forwardedHeaders,
    signal: c.req.raw.signal,
  })
}
```

- [ ] **Step 2: routes.ts 切换**

替换 `dataPlane.post('/v1/messages/count_tokens', ...)` 整段 inline handler：

```ts
// 顶部 imports
import { countTokensHandler } from './chat-flow/count-tokens/http.ts'

// 路由
dataPlane.post('/v1/messages/count_tokens', countTokensHandler)
```

删除 `routes.ts` 中现已无人使用的 imports：
- `parseMessagesCountTokensPayload`
- `resolveBinding`
- `stripUpstreamPin`

仍保留：`PreviousResponseNotFoundError` / `expandPreviousResponseId` / `savePostTurnSnapshot` / `getResponsesStore` / `parseResponsesPayload` / `parseResponsesSSEStream` / `handleResponsesImageGeneration` / `hasImageGeneration` —— 这些是 `/v1/responses` inline handler 还在用的，C2.3 才会拆。

- [ ] **Step 3: 跑 count-tokens 测试**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/gateway/tests 2>&1 | grep -E "count.tokens|count_tokens" | head -20
```

Expected: 既有的 count-tokens 测试全部通过。

随后跑全量 curated：

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test 2>&1 | tail -5
```

Expected: pass 数不下降于 C2.1 结尾的基线。

- [ ] **Step 4: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/count-tokens/http.ts packages/gateway/src/data-plane/routes.ts
git commit -m "refactor(gateway/chat-flow): wire count-tokens handler"
```

---

## 验收（本 plan 结尾）

1. `routes.ts` 已不含以下任意端点的内联 handler：`/v1/messages`、`/v1/chat/completions`、`/v1beta/models/:model{.+}`、`/v1/messages/count_tokens`。
2. `routes.ts` 仍保留 `/v1/responses` 的内联 handler（C2.3 处理）。
3. 4 个新 `serve.ts` 文件均不 import `hono`：

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  ! grep -rE "from ['\"]hono['\"]" packages/gateway/src/data-plane/chat-flow/{messages,chat-completions,gemini,count-tokens}/serve.ts
```

4. `bun test`（curated）pass 数不下降。
5. `bunx tsc --noEmit` PASS。

下一步：执行 Plan C2.3（responses + sidecar）。
