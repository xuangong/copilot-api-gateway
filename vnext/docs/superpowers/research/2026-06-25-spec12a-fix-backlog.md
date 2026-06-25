# Spec 12a — Fix Backlog (post-audit)

**Date:** 2026-06-25
**Source:** `2026-06-25-spec12a-parity-report.md` (8 parity / 1 cosmetic / **12 behavior-gap** / **6 route-missing**)
**Goal:** drive `behavior-gap + route-missing → 0`,unlock Spec 12b。

## Clusters (按"动手成本 × 收益"排序)

### F1 — alias 路由缺失 (route-missing ×2) — **trivial,先做**

- `alias-e1-chat-completions` `/chat/completions` → vnext 404
- `alias-e2-responses` `/responses` → vnext 404

**fix:** `vnext/packages/gateway/src/data-plane/routes.ts` 增加非 v1 前缀别名 (复用 v1 handler)。

**预估:** 1 个 PR / <50 行 / 0 风险。

---

### F2 — Gemini 路由整族缺失 (route-missing ×4) — **medium,文件已存在**

- `gemini-count-tokens` `/v1beta/models/...:countTokens`
- `gemini-generate-content` `/v1beta/models/...:generateContent`
- `gemini-stream-generate-content` `/v1beta/models/...:streamGenerateContent?alt=sse`
- `gemini-tool-call` `/v1beta/models/...:generateContent` (with tools)

**现状:** `vnext/packages/gateway/src/data-plane/chat-flow/gemini/http.ts` 已存在但未挂载到 routes。

**fix:** routes.ts 注册 `/v1beta/models/:modelWithMethod`(动态 sub-method dispatch) → 路由到现有 gemini handler。

**预估:** 1 PR / ~30 行 routes 改动 + 可能补 sub-method 解析。

---

### F3 — `responses-stateful-chain` sqlite 表缺失 — **bug,blocker for stateful**

- vnext 报 `no such table: responses_snapshots`
- root 报正常的 `Previous response not found` (走 in-memory store)

**fix:** vnext schema migration 补 `responses_snapshots` 表 (定义见 root `src/lib/responses-store.ts` 类似实现);或暂时改 in-memory 兜底。

**预估:** 1 PR / schema + bootstrap。需要决策: 持久化 vs 内存。

---

### F4 — `/v1/responses` non-stream + stream 400 — **业务核心 gap**

- `responses-basic-non-stream`: root 200 / vnext 400
- `responses-stream`: root 200 / vnext 400 (返回 JSON 而非 SSE)

**现状:** vnext 收到 fixture body 直接 400,可能 body schema 校验比 root 严格。

**fix:** 抓 vnext 400 body 看具体校验错;放宽或对齐 schema。

**预估:** 1 PR / 1-2 文件;依赖先 debug 看 400 原因。

---

### F5 — models 三端点 body shape (behavior-gap ×3) — **可能要 enrich vnext models list**

- `/v1/models`、`/models`、`/api/models` 共同缺:
  - `capabilities.family` (root `claude-opus-4.6`,vnext `copilot`)
  - `capabilities.limits.{max_non_streaming_output_tokens, vision}`
  - `capabilities.supports.{adaptive_thinking, max_thinking_budget, min_thinking_budget}` 等
- 额外 header cosmetic-diff: `content-type` 带 `;charset=utf-8`

**决策点:** vnext models list 是简化版还是要 1:1 复刻 root 的 Copilot models capabilities schema?

**fix 方向 A:** vnext 引入 root 的 model-list 完整 schema (copy `src/services/copilot/get-models.ts` 的 capability mapping)。
**fix 方向 B:** 把这些字段标为"可选 vendor extension",从 audit strong-field 列表中豁免。

**预估:** A 1 PR / 中等;B 0 代码 + 改 audit + 加 spec 决策。

---

### F6 — chat-completions Azure padding 字段 (behavior-gap ×2) — **同 F5 决策**

- `chat-completions-basic-non-stream` + `chat-completions-tool-required` 共同缺:
  - `$.choices[0].content_filter_results` / `$.choices[0].message.padding`
  - `$.prompt_filter_results` / `$.service_tier` / `$.copilot_usage`
- vnext 多 `$.object`

**性质:** root 透传上游 Copilot/Azure 的 padding 字段;vnext 在 transform 时丢了。

**fix 方向 A:** vnext transform 改为 pass-through unknown 字段。
**fix 方向 B:** audit 豁免这些 vendor-specific 字段(类似 `system_fingerprint` 已豁免)。

**预估:** A 1 PR;B audit 改 ignore-list。

---

### F7 — chat-completions stream event count (behavior-gap ×1) — **可能是 usage 帧拼接差异**

- `chat-completions-stream-include-usage` SSE event count root=5 vnext=4

**fix:** 抓双侧 raw SSE 看缺哪一帧 (大概率是单独的 usage chunk 或 `[DONE]` 前的额外 final chunk)。

**预估:** 1 PR / 中等;需要 stream chunk 级 trace。

---

### F8 — messages-basic Anthropic padding (behavior-gap ×1)

- `$.copilot_usage`、`$.stop_details` 缺
- `usage` 缺 `cache_creation`、`inference_geo`

**性质:** 同 F6,vnext transform 丢 vendor 字段。

**fix 方向:** 同 F6 (pass-through 或 audit 豁免)。

**预估:** 同 F6。

---

### F9 — embeddings root 500 (behavior-gap ×2) — **root bug,不是 vnext 问题**

- `embeddings-single-string`: root **500** vnext 200
- `alias-e3-embeddings`: root **500** vnext 200

**性质:** root 服务自己挂了 (`$.error: string` returned)。vnext 工作正常。

**fix 方向:** 这是 audit 把 root 当 ground truth 的副作用。如果接受"vnext 已正确处理",harness 应该把 `root 5xx vs vnext 2xx` 单列为 `root-broken` 标签,不计入 vnext 的 gap。

**预估:** harness 改 1 PR;或忽略,标记为 "root 已知坏路径,vnext OK"。

---

### F10 — content-type charset cosmetic (cosmetic-diff ×1+若干 header diff)

- vnext 默认 `application/json;charset=utf-8`,root `application/json`
- 出现在: embeddings-array-three, chat-completions ×2, messages-basic, models ×3

**fix:** vnext 的 JSON response helper 去掉 charset(或反过来给 root 加上;但 root 是 Hono 默认,改 vnext 更稳)。

**预估:** 1 PR / 1 helper。

---

## 推荐执行顺序

| # | spec | 类型 | 阻塞? |
|---|------|------|------|
| 1 | F1 alias 路由 | trivial | no |
| 2 | F10 charset header | trivial | no |
| 3 | F2 gemini 路由挂载 | medium | unblocks 4 fixtures |
| 4 | F9 audit root-broken 标签 | harness | de-noise 2 fixtures |
| 5 | F3 responses_snapshots schema | bug | unblocks F4 调试 |
| 6 | F4 responses 400 调试 | debug | 核心 |
| 7 | F5/F6/F8 vendor padding 决策 | **需要你拍方向** | 5 fixtures 共享 |
| 8 | F7 chat stream event count | trace | last mile |

**关键决策点 (需要你定):**

1. **vendor padding 字段 (F5/F6/F8 共 5 fixtures):** 让 vnext pass-through (1:1 复刻 root) 还是 audit 豁免 (承认 vnext 是"clean view")?
2. **F9 root 500:** root 已知坏 — 加 `root-broken` 标签去噪,还是要先修 root?
3. **F3 responses snapshots:** 持久化还是 in-memory 兜底?

回 "继续" + 决策 (例如 "F1+F10 先做,vendor 走 pass-through") 我直接进 brainstorm/plan/exec 链。

---

## 决策 (2026-06-25, by user)

1. **vendor padding → vnext pass-through.** 参考 sibling 项目 `/Users/zhangxian/projects/copilot-gateway`:
   - `packages/gateway/src/data-plane/llm/chat-completions/events/reassemble.ts` 明确保留 `prompt_filter_results`
   - `reassemble_test.ts` 有 "preserves unknown choice-level fields (content_filter_results)" 用例
   - 结论: 这些是上游 (Azure / Copilot) 的安全审计字段,下游可能消费 → vnext transform 改 pass-through unknown 字段
2. **F9 root 500 embeddings → 先修 root.** 不加 `root-broken` 标签;先看 root `src/routes/embeddings/handler.ts` 为何 500。
3. **F3 responses_snapshots → in-memory store 兜底.** 先让 stateful chain 在内存里 work,持久化后置。

## 执行顺序 (确定版)

| seq | cluster | gap 数 | 类型 |
|-----|---------|------|------|
| 1 | F1 alias 路由 (`/chat/completions`、`/responses`) | 2 | trivial |
| 2 | F10 charset header 对齐 | 1+ cosmetic | 1-line helper |
| 3 | F2 Gemini 路由挂载 | 4 | medium |
| 4 | F9 修 root `/v1/embeddings` 500 | 2 | root bug |
| 5 | F3 responses in-memory store | 1 | feature |
| 6 | F4 `/v1/responses` 400 调试 | 2 | debug (依赖 F3) |
| 7 | F5+F6+F8 vendor padding pass-through | 5 | refactor |
| 8 | F7 chat stream event count | 1 | trace |

每个 cluster: brainstorm (small) → spec → impl → re-run audit → commit。

**当前进度:** 开始 F1。

