# P1: chat ↔ responses 翻译对 + previous_response_id 快照展开

> **Status:** Approved 2026-06-12.
> **Branch context:** vNext refactor，所有 P1-P3 完成后再切换生产。

## Goal

为 `/v1/responses` 路由补齐两个能力，以满足真实 OpenAI/Codex 客户端在 vNext 上多轮使用：

1. **chat ↔ responses 双向翻译对** — 当模型只提供 `chat_completions` endpoint 时，让 `responses` 客户端也能落地；当模型只提供 `responses` endpoint 时，让 `chat_completions` 客户端也能落地。这是 mesh 的最后两条边。
2. **`previous_response_id` 快照展开** — 将上一轮 `responses` 输出（input items + output）持久化为 snapshot，下一轮请求出现 `previous_response_id` 时由 gateway 展开为完整 input 并删字段，向上游隐藏多轮状态。

## 非目标 (P2/P3)

- WebSocket / 长连接 affinity（不需要，因为 store 已外部化）
- Item rewrite / normalize-assistant-content（Floway 的边界裁剪，vNext 暂未遇到该痛点）
- 跨 apiKeyId 的 snapshot 共享
- TTL 之外的精细 GC 策略（cron job、容量上限等）
- 把 store 反向接到 messages / gemini 路由（这两类客户端无 previous_id 概念）

---

## 架构总览

```
client (POST /v1/responses, body 含 previous_response_id?)
   │
routes.ts /v1/responses
   │ 1. parseResponsesPayload
   │ 2. expandPreviousResponseId(payload, store, apiKeyId)   ← 新增 bridge
   │     • 命中：load snapshot → prepend items → delete previous_response_id
   │     • 未命中：throw PreviousResponseNotFoundError → repackage 为 verbatim 400
   │ 3. enumerateBindingCandidates / selectPair
   │     ─ pair-selector PREFERENCE 不变
   │ 4. getTranslator(source, target)
   │     ─ 新注册:  chat_completions ⇆ responses
   │ 5. translator.translateRequest(payload, ctx)
   │ 6. runConversationAttempt → upstream
   │ 7a. stream: parseTargetSSE → translateEvents → encodeClientSSE
   │     ─ stream 收尾时把 (input items, output items) 喂回 store.save
   │ 7b. non-stream: translateBody(json) → client JSON
   │     ─ Response.json 之前 store.save
   │
store: ResponsesSnapshotStore  (D1 on CFW, bun:sqlite local)
       表 responses_snapshots(response_id PK, api_key_id, model, items_json, created_at, expires_at)
       opportunistic GC: 每次 save 顺手 DELETE WHERE expires_at < now LIMIT N
```

---

## 组件分解

### 1. 新独立包 `packages/responses-store/`

**为什么是独立包**（参考 `packages/translate` 的边界先例）：
- store 与 `provider-copilot` / `provider-custom` 无关，是数据平面的横向能力
- `apps/gateway` 不该直接依赖 D1 / sqlite 驱动；走包边界保持 worker bundle 干净
- 测试隔离：内存实现可在 translator 单测里被注入，无需 mock module（避开历史 mock.module 不可还原坑）

**导出**

```ts
// packages/responses-store/src/index.ts
export interface ResponsesSnapshot {
  responseId: string
  apiKeyId: string | null   // null = anonymous owner，仍然严格按 null 自隔离
  model: string
  items: unknown[]          // 完整快照：上一轮的 input items + output items（Responses 协议形态）
  createdAt: number         // ms
  expiresAt: number         // ms
}

export interface ResponsesSnapshotStore {
  load(responseId: string, apiKeyId: string | null): Promise<ResponsesSnapshot | null>
  save(snap: ResponsesSnapshot): Promise<void>
}

export class InMemoryResponsesSnapshotStore implements ResponsesSnapshotStore { /* tests + dev */ }
export class SqliteResponsesSnapshotStore implements ResponsesSnapshotStore { /* prod */ }
//   ctor 接受 { exec(sql, params): Promise<...> } 形态的薄 driver；CFW 适配 D1，本地适配 bun:sqlite
```

**所有权隔离规则**：`load(responseId, apiKeyId)` 内部 `WHERE response_id = ? AND api_key_id IS NOT DISTINCT FROM ?`。两个不同 apiKey 的客户端即使猜到对方的 response_id，也读不到对方快照。

**TTL**：默认 24h（常量 `DEFAULT_TTL_MS = 24 * 3600_000`，可由 ctor option 覆盖）。

**GC**：每次 `save` 后顺手发一条 `DELETE FROM responses_snapshots WHERE expires_at < ? LIMIT 100`，无独立调度器。CFW 上 D1 是 eventually consistent，无锁压力。

### 2. 数据库 migration

新文件：`vnext/migrations/0001_responses_snapshots.sql`

```sql
CREATE TABLE IF NOT EXISTS responses_snapshots (
  response_id   TEXT    PRIMARY KEY,
  api_key_id    TEXT,                 -- nullable for anonymous
  model         TEXT    NOT NULL,
  items_json    TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_snapshots_expires
  ON responses_snapshots(expires_at);
CREATE INDEX IF NOT EXISTS idx_responses_snapshots_owner
  ON responses_snapshots(api_key_id, response_id);
```

D1 binding 与现有 control-plane 的 D1 共用同一数据库实例（同一 wrangler binding name），表名隔离即可。

### 3. 新翻译对子

#### `packages/translate/src/chat-completions-via-responses/`

输入：`chat_completions` 客户端 payload（OpenAI Chat 形）。
目标：`responses` upstream（Anthropic / 自定义后端可能只暴露 responses）。

实现要点：
- `translateRequest`: chat `messages[]` → responses `input[]`（system 拼到 instructions 或首条 input system item）；`tools[]` 直转；`tool_choice` 直转；`max_tokens` → `max_output_tokens`；`stream` 透传
- `translateEvents`: 接收 ResponsesEvent，映射为 OpenAI Chat SSE chunk（`choices[].delta.content`、`tool_calls[].function.arguments` 增量、`finish_reason`、最终 `[DONE]`）
- `translateBody`: Responses JSON → ChatCompletion JSON（合并 output_text、tool_calls，`usage` 字段名转换）

#### `packages/translate/src/responses-via-chat-completions/`

输入：`responses` 客户端 payload。
目标：`chat_completions` upstream。

实现要点：
- `translateRequest`: responses `input[]` → chat `messages[]`（含系统 item 还原 system role；`function_call_output` item → `role:"tool"`）
- `translateEvents`: ChatCompletionChunk → ResponsesEvent（`response.created` → `output_text.delta` → `output_item.added/done`(tool_calls) → `response.completed`）
- `translateBody`: ChatCompletion JSON → Responses JSON（output items 数组、`output_text` 聚合）

#### 注册

`packages/translate/src/index.ts` 新加两条 entry，`apps/gateway/src/data-plane/dispatch/translator-registry.ts` 的 TABLE 增加：

```ts
[['chat_completions', 'responses'],     chatCompletionsViaResponses],
[['responses',        'chat_completions'], responsesViaChatCompletions],
```

PREFERENCE 表保持不变。

### 4. dispatch bridge — `responses-store-bridge.ts`

新文件：`vnext/apps/gateway/src/data-plane/dispatch/responses-store-bridge.ts`

```ts
export class PreviousResponseNotFoundError extends Error {
  readonly status = 400
  constructor(readonly responseId: string) { super(`Previous response with id '${responseId}' not found.`) }
}

/** Mutates payload in place: prepends snapshot items to input, deletes previous_response_id. */
export async function expandPreviousResponseId(
  payload: { previous_response_id?: string | null; input?: unknown[] },
  store: ResponsesSnapshotStore,
  apiKeyId: string | null,
): Promise<void> { /* ... */ }

/** Persist this turn's snapshot for the *next* turn's expansion. */
export async function savePostTurnSnapshot(
  store: ResponsesSnapshotStore,
  args: { responseId: string; apiKeyId: string | null; model: string; inputItems: unknown[]; outputItems: unknown[] },
): Promise<void> { /* ... */ }
```

错误形态对齐 OpenAI 真实捕获（参考 floway/llm/responses/serve-prep.ts 的 verbatim envelope）：

```json
{ "error": { "message": "...", "type": "invalid_request_error",
             "param": "previous_response_id", "code": "previous_response_not_found" } }
```

`errors/repackage.ts` 在 sourceApi=='responses' 路径下识别该错误，原样输出。

### 5. routes.ts 改动

仅 `/v1/responses` 路由分支改：
- 在 `parseResponsesPayload` 之后、`enumerateBindingCandidates` 之前调用 `expandPreviousResponseId`
- 在 stream 路径的 `encodeClientSSE` 终止处、non-stream 路径 `translateBody` 之后调用 `savePostTurnSnapshot`
- store 实例由 `Env` 注入（`Env.responsesStore: ResponsesSnapshotStore`），构造在 `apps/gateway/src/app.ts`：CFW 用 `SqliteResponsesSnapshotStore(d1Binding)`；本地用 `bun:sqlite`

`/v1/messages`、`/v1/chat/completions`、Gemini 路由不变。

### 6. errors/repackage.ts

接住 `PreviousResponseNotFoundError`，按 `sourceApi=='responses'` 输出上述 verbatim envelope，HTTP 400。

---

## 测试策略

| 层级 | 文件 | 覆盖 |
|------|------|------|
| 翻译对单测 | `packages/translate/src/chat-completions-via-responses/__tests__/` | request/events/body 三方向；tool_calls；多 system；空 messages |
| 翻译对单测 | `packages/translate/src/responses-via-chat-completions/__tests__/` | 同上反向；function_call_output → role:"tool" |
| Store 单测 | `packages/responses-store/src/__tests__/` | InMemory + Sqlite 两实现共用契约：load 命中/未命中、apiKeyId 隔离、TTL 过期、GC 触发 |
| Dispatch E2E | `vnext/tests/e2e/responses-previous-id.test.ts` | 起 in-process gateway + InMemoryStore：第一轮存储 → 第二轮带 previous_id 命中 → 不存在的 id → 跨 apiKey 拒绝 |
| SDK 集成 | `tests/sdk-openai-responses-multi-turn.test.ts` | 真实 `openai` SDK 多轮 `previous_response_id`，对 chat backend 模型 + responses backend 模型各跑一次 |

---

## Open assumptions（实施前可挑）

1. D1 与本地 sqlite 的 driver 抽象层放在 `packages/responses-store` 内部（不做成更通用的 `packages/storage`）。如果以后还有第二张表也要做同样的双后端，再升级。
2. `items_json` 用 `TEXT` + `JSON.stringify`。表里没有 `items_jsonb`/`json` 列类型——D1 是 SQLite，TEXT 已是惯例。
3. `previous_response_id` 之外的 `store.use_chain` 等 OpenAI 高级字段不实现（YAGNI；当前 Codex/openai-node 主流用法只用到 previous_response_id）。
4. snapshot 内容是「上轮 input + 上轮 output」的合并 items 数组，下一轮 prepend 完直接交给 translator；不在 store 里做 schema validation。
5. CFW 上 D1 写入有 ms 级延迟，前后两个请求紧接发到不同 worker 实例时可能读到旧值。可接受——客户端永远用上一轮真实拿到的 response.id，至少一次写入已 commit 才会返回 id 给客户端。

---

## 与 Floway 的差异

| 维度 | Floway | vNext (P1) |
|------|--------|------------|
| 翻译对总数 | 9 | 7（5 已注册 + 本 P1 增加 2） |
| store 实现 | 内置 KV + KV adapter | 独立 package，D1/sqlite |
| previous_id 错误 | verbatim 上游捕获 | 同上（直接复用 Floway envelope 字串） |
| GC | 定期 cron | 机会式 |
| 跨多 apiKey 共享 | 否 | 否（一致） |
| WebSocket affinity | 否 | 否（一致） |
