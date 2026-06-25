# Spec 12a — Data-Plane Parity Audit (vNext ↔ root src/)

**日期:** 2026-06-25
**前置:** vNext Roadmap §3 step 7 (cutover) 的前置闸门
**Umbrella:** Spec 12 (vNext Parity Audit),含 12a/12b/12c/12d 共四 sub-spec
**对象:** root `src/routes/` 中 data-plane LLM endpoint × vNext `packages/gateway/src/data-plane/*` 实现

---

## 1. 目标 & 范围

证明 vNext 在 **行为级** 上 ≥ root `src/` 的 data-plane LLM endpoints,产出 gap report 作为 Step 7 cutover 触发条件。

**只 audit,不修复任何 gap。** Gap 写入 report,后续按 fix-spec 处理。

**显式范围:** 7 个 endpoint families,12 个 HTTP paths:

```
POST /chat/completions, /v1/chat/completions
POST /v1/messages
POST /v1/messages/count_tokens
POST /responses, /v1/responses
POST /embeddings, /v1/embeddings
POST /images/generations, /v1/images/generations
POST /images/edits, /v1/images/edits
GET  /models, /v1/models, /api/models
POST /v1beta/models/:modelWithMethod   (Gemini generateContent + streamGenerateContent)
```

**显式不在范围:**
- control-plane (api-keys / upstreams / copilot-quota / token-usage / presence / observability-shares / data-transfer) — Spec 12b
- auth flow (device / oauth / email) — Spec 12d
- dashboard UI 渲染 — Spec 12c
- perf / latency 对比 — 留给 Spec 12 epilogue
- 任何代码修改 (audit 模式)
- prod 上跑
- push / merge main (允许 push 到 vNext 远端,不 merge)

## 2. 双起 fixture

| 实例 | 启动 | URL | env |
|------|------|-----|-----|
| root src/ | `bun run local` (从 repo root) | `http://127.0.0.1:4141` | repo root `.env` |
| vnext | `docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d` | `http://127.0.0.1:41415` | `.env.vnext` |

**Env 互斥前置 audit (Task 1):**
- GH token:若两端复用同一 token,audit harness 强制 **串行** 发请求 (无 concurrency),避免 quota 撞车
- sqlite/D1:vnext 走容器内 `/data/vnext.sqlite`,root 走本地 `tmp/copilot.sqlite`,天然隔离
- 若发现冲突字段 → spec 在 §7 "blocker" 中记录,audit 不启动

## 3. Harness 工具

**位置:** `vnext/scripts/parity/data-plane-audit.ts` (新增,bun-native,单文件)

**输入:**
- `vnext/scripts/parity/fixtures/data-plane/*.json` — 每个文件一个 fixture,含:
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
- `${API_KEY}` 走 env 注入 (`PARITY_API_KEY` 必须双端同 key)

**行为:** 每 fixture →
1. `fetch http://127.0.0.1:4141${endpoint}` 收 root response
2. `fetch http://127.0.0.1:41415${endpoint}` 收 vnext response
3. diff 三层:status / header allowlist / body (or SSE)
4. 写一行到 report:`<endpoint> <fixture> <label> <gap摘要>`

**diff 规则:**

| 层 | 规则 |
|----|------|
| status | 严格相等 |
| header | allowlist `[content-type, x-request-id, transfer-encoding, cache-control]`;value 模式化 (uuid → `<uuid>`,port → `<port>`,数字 → `<num>`);其余 header 忽略 |
| JSON body | 递归 deep-diff;**忽略字段** `id / created / system_fingerprint / x_request_id / response_id / fingerprint`;**强校验字段** `model / object / choices[].finish_reason / choices[].message.role / choices[].message.content (非空判) / usage 的 key 列表 (值忽略)` |
| SSE | 按 `event:` + `data:` 行还原成 logical message 序列;event 名严格比;data 增量按字符串 join 后比 trimmed text;时间戳/chunk 边界忽略 |

**输出:** `vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md` (自动生成,人可读 markdown 表 + per-fixture diff 详情 appendix)

## 4. Fixtures (21 条)

每 endpoint family 3 条:happy non-stream / happy stream / common 4xx 或第 3 个变体。真实 LLM 走 cheapest model。

| family | fixture 列表 |
|--------|--------------|
| chat-completions | (a) basic non-stream gpt-4o-mini (b) stream w/ stream_options.include_usage (c) tool_choice="required" + 1 tool |
| messages | (a) basic non-stream claude-haiku-4-5 (b) stream (c) `/v1/messages/count_tokens` 单 msg 计数 |
| responses | (a) basic non-stream gpt-4o-mini (b) stream (c) stateful: 先发一条拿 response_id,再发带 previous_response_id |
| gemini | (a) generateContent gemini-2.5-flash (b) streamGenerateContent (c) tool 调用 (1 functionDeclaration) |
| embeddings | (a) single string text-embedding-3-small (b) array of 3 strings (c) bad model "nonexistent" → 期 4xx |
| images | (a) generations dall-e-2 256x256 (b) edits 用 fixed 8x8 PNG (c) bad size "1x1" → 期 4xx;若 (b) 不稳则降级为只跑 (a) + (c) |
| models | (a) GET /v1/models (b) GET /models (c) GET /api/models |

**注:** messages family (c) 用 count_tokens 而非 tool_use,因为 tool_use 与 chat-completions (c) 重合 (两者翻译路径会汇到同一 translator);count_tokens 走独立路径更值得 audit。共 21 条。

**调用预算:** 21 fixtures × 2 servers = 42 calls,串行 (env 互斥时),~5 min 完成。

## 5. Gap 分类 & label

| label | 含义 | action |
|-------|------|--------|
| `parity` | 三层全 match | 进入 cutover 候选 |
| `cosmetic-diff` | 仅 ignored 字段或 allowlist 外 header 不同 | 进入 cutover 候选,不阻断 |
| `behavior-gap` | 强校验字段不同 / SSE 序列不同 / status 不同 | 写入 report,生成后续 fix-spec |
| `route-missing` | vnext 不挂该 path 或 405 | 写入 report,生成后续 fix-spec |

## 6. Acceptance gates

| ID | Gate | 期望 |
|----|------|------|
| A1 | 双起 health check (`GET /v1/models` 双端都 200,或 401 但同样 401) | 通过 |
| A2 | 21 fixtures 全跑完,无 harness crash | 21/21 |
| A3 | report 生成,含每 fixture: endpoint + label + 关键 diff 摘要 + appendix 完整 diff | 文件存在,markdown 解析正确 |
| A4 | report 顶部 summary 表:`parity / cosmetic-diff / behavior-gap / route-missing` 四类计数 | summary 存在 (数值本身不阻断,只看是否生成) |
| A5 | spec + harness + fixtures + report 单 commit 入 repo `vnext/scripts/parity/` + `vnext/docs/` | commit hash 可查;允许 push vNext 远端,不 merge |

**A4 解释:** audit spec 本身不规定 "必须 0 gap" 阈值,因为 gap 数量是 audit 的 *产出* 不是 *输入*;cutover 触发条件由后续 fix-spec 决定 (例如 `behavior-gap + route-missing = 0`)。

## 7. 风险 & blocker

| 风险 | 缓解 |
|------|------|
| root `bun run local` 起不来 (.env 缺字段 / port 占用 / sqlite 路径) | Task 1 前置验证;起不来 → spec blocked,记入 `12a-blockers.md` |
| GH token 复用撞 quota | harness 强制 sequential;预估每 fixture ≤ 1 上游 token call,21 calls 无压力 |
| 真实 LLM 抖动 (model 偶发返回不同 finish_reason / 不同 tool 选择) | 强校验字段只限结构性 key (finish_reason 的存在 + role 的值 + usage key 集),不比 content 文本 |
| SSE chunk 边界差异噪声 | logical-message join 后比 trimmed text;chunk 数不比 |
| images/edits 需要 multipart upload 复杂 | 用 fixed 8x8 transparent PNG (base64 内联到 fixture);失败则该 fixture 降级 4xx-only |
| port 4141 已被根 `bun run local` 占用,vnext 容器映射 41415 不冲突 | 默认配置就错开,无需调 |
| .env 与 .env.vnext 中 D1/sqlite 路径互踩 | §2 已验证天然隔离 |

## 8. 显式不做

- 不修任何 gap (写 fix-spec 是下一步,不在 12a)
- 不跑 control-plane / dashboard / auth (12b/12c/12d)
- 不做 perf / latency
- 不在 prod 上跑
- 不 merge main

## 9. 输出物清单

| 文件 | 类型 | 提交 |
|------|------|------|
| `vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md` | 本 spec | commit 1 |
| `vnext/docs/superpowers/plans/2026-06-25-spec12a-data-plane-parity-audit.md` | plan | commit 2 |
| `vnext/scripts/parity/data-plane-audit.ts` | harness | commit 3 |
| `vnext/scripts/parity/fixtures/data-plane/*.json` (21 文件) | fixtures | commit 3 |
| `vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md` | audit 输出 | commit 4 |
| (可选) `vnext/docs/superpowers/research/2026-06-25-spec12a-blockers.md` | 若 Task 1 阻断 | commit (条件) |

## 10. 后续

12a 完成后 →
- 若 `behavior-gap + route-missing = 0`:启动 12b control-plane audit
- 否则:启动 fix-spec 系列;每个 fix-spec 完成后 re-run 12a harness 直到清零
- 12a/b/c/d 全清零 → 启动 Spec 13 (cutover spec,删 root src/ + vnext 提升根)
