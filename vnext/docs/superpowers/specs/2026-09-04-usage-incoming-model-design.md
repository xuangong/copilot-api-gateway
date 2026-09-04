# Usage Incoming Model 维度设计

**日期：** 2026-09-04  
**状态：** 已批准，待实施计划

## 1. 目标

为 Usage 增加一等维度 `incoming model`，长期记录调用方在 API Key 模型映射执行前所选择的规范化逻辑模型。该维度与映射后的公开模型、provider 实际计价键并存，使系统能同时回答：

1. 调用方原本选择了什么模型或 alias；
2. API Key mapping 最终将请求路由到什么公开模型；
3. provider 实际使用哪个内部模型键执行和计价。

## 2. 三层模型身份

Usage 中固定以下语义：

```ts
interface UsageRecord {
  incomingModel: string
  model: string
  modelKey: string
}
```

| 字段 | 含义 | 是否受后续修正影响 |
|---|---|---|
| `incomingModel` / `incoming_model` | API Key mapping 前的规范化逻辑模型 | 一经产生不可修改 |
| `model` | mapping 后的公开 destination model | 保持外层公开身份 |
| `modelKey` / `model_key` | provider 实际执行和计价键 | 可由终态 provider model correction 更新 |

示例：

```text
客户端请求：up_A/gpt-5.6-sol
Key mapping：gpt-5.6-sol → gpt-5.6-sol-fast
上游回显：gpt-5.6-sol

incoming_model = gpt-5.6-sol
model          = gpt-5.6-sol-fast
model_key      = gpt-5.6-sol
upstream       = up_A
```

## 3. Incoming Model 的规范化规则

采用“映射前的规范化逻辑模型”，不保存原始 wire 字符串。

### 3.1 通用规则

```text
incoming_model
= 去除显式 up_*/ upstream pin
+ 完成协议兼容规范化
+ 尚未执行 API Key mapping 的 bare logical model
```

因此：

- `up_A/friendly-model` 的 incoming model 是 `friendly-model`；
- upstream pin 不进入 incoming model，实际 upstream 由既有 `upstream` 字段表达；
- source alias 可以不在可用模型目录中；
- mapping disabled 或没有匹配规则时，`incomingModel` 通常等于公开 `model`；
- provider response model、跨协议 translation 和终态 correction 都不得改写 incoming model。

### 3.2 Gemini

Gemini 先完成协议兼容规范化，再采集 incoming model：

```text
URL model
→ 分离 up_* pin
→ 去除 -customtools
→ gemini-2.5-* compatibility alias normalization
→ incoming model
→ API Key mapping
```

示例：

```text
原请求：up_A/gemini-2.5-flash-customtools
incoming_model：gemini-3-flash-preview
model：API Key mapping 后的 public destination
model_key：hub/provider 实际计价模型
```

raw URL model 仍可由 request dump 保存；Usage 不新增 `requested_model_raw`。

## 4. 请求身份传播

### 4.1 ResolvedKeyModel

模型映射解析结果增加明确的 incoming identity：

```ts
interface ResolvedKeyModel {
  incomingModel: string
  routedModel: string
  upstreamPin?: string
  matchedRuleIndexes: number[]
}
```

`incomingModel` 为去 pin 后、映射前的 bare model；`routedModel` 为映射后的 bare destination。两者不得通过拼接 pin 混用。

### 4.2 TelemetryModelIdentity

Telemetry identity 增加：

```ts
interface TelemetryModelIdentity {
  incomingModel: string
  model: string
  modelKey: string
  upstream: string
  cost: ModelPricing | null
}
```

所有 model resolver 遵守：

- 保留 `incomingModel`；
- 保留公开 `model`；
- 只更新 `modelKey` 与对应 `cost`；
- `translatorPair` 保持现有 source/hub provenance；
- 无价格的真实 correction 使用 corrected `modelKey` 与 `cost: null`，不得沿用旧价格。

### 4.3 多轮和跨协议

- Responses `previous_response_id`：incoming model 来自当前外层请求，不从 snapshot model 反推或覆盖；
- server-tool / ReAct：所有内部轮次累计到最外层请求的 incoming model；
- 跨协议：例如 Gemini→Responses，incoming model 始终为 Gemini 映射前逻辑模型；
- nested result、resolver 和 authoritative `finalMetadata` 必须携带并保留 incoming model。

## 5. API Surface 覆盖

所有会产生 Usage 的模型请求都必须携带 incoming model：

- Anthropic Messages；
- OpenAI Responses；
- Chat Completions；
- Gemini generate/stream；
- Embeddings / Ollama embed；
- Image generation；
- JSON/multipart image edits；
- Ollama chat。

Count-token 请求参与相同的 incoming→routed 模型选择，但当前不写生成 Usage，因此：

- Anthropic count tokens 与 Gemini countTokens 继续使用正确的 mapped model；
- 不为它们凭空创建 Usage row。

## 6. 数据库 Schema

### 6.1 Migration

新增 `0008_usage_incoming_model.sql`，不修改已应用 migration。

```sql
ALTER TABLE usage
  ADD COLUMN incoming_model TEXT NOT NULL DEFAULT '';

ALTER TABLE usage_requests
  ADD COLUMN incoming_model TEXT NOT NULL DEFAULT '';

DROP INDEX idx_usage_identity;
DROP INDEX idx_usage_requests_identity;

CREATE UNIQUE INDEX idx_usage_identity
ON usage (
  key_id,
  incoming_model,
  model,
  COALESCE(upstream, ''),
  model_key,
  client,
  hour,
  dimension
);

CREATE UNIQUE INDEX idx_usage_requests_identity
ON usage_requests (
  key_id,
  incoming_model,
  model,
  COALESCE(upstream, ''),
  model_key,
  client,
  hour
);
```

必须同时修改两张表和两个唯一索引。只修改 token 表会让 requests 与 token bucket 错配或倍增。

### 6.2 为什么使用非空空字符串

历史行使用：

```text
incoming_model = ''
```

固定表示：

```text
Legacy / Unknown
```

不使用 `NULL`，因为 SQLite/D1 的 UNIQUE index 允许多个 NULL 不冲突，会破坏 additive upsert 的聚合幂等性。

### 6.3 历史数据

不回填历史 incoming model。

原因：

- 历史 Usage 没有当时生效的 mapping snapshot；
- 当前 mapping 可能已被修改；
- 多个 source aliases 可映射到同一 destination；
- request dump 不保证开启且有 retention；
- 用 routed `model` 回填会伪造原始调用事实。

Migration 仅通过 `DEFAULT ''` 赋予历史记录 unknown 值。历史 token、request count、费用和原唯一维度不得改变。

## 7. Repository 修改边界

`incomingModel` 必须加入所有 Usage storage identity 路径：

- usage/usage_requests column constants；
- DB row interfaces；
- `UsageRecord`；
- bucket key；
- `assembleUsageRecords()`；
- `record()` additive upsert；
- `set()` replacement upsert；
- `set()` delete predicate；
- usage_requests conflict key；
- list/query SELECT projection；
- SQLite 与 D1 共用 repo；
- migration schema baseline。

示例：

```text
alias-a → target
alias-b → target
```

同一 key/client/hour/model/modelKey 下必须保留两个独立 incoming buckets。若 incoming model 不在唯一键中，写入时发生的合并不可逆。

## 8. 服务端展示聚合

`aggregateUsageForDisplay()` 的分组键增加 incoming model：

```text
keyId + incomingModel + model + client + hour
```

既有展示聚合仍可合并 upstream 与 provider modelKey，但不同 incoming model 不得在 API 返回前合并。

示例：

```text
alias-a → target：100 tokens
alias-b → target：200 tokens
```

API 返回两条 incoming buckets；Dashboard 按 routed model 分布时可以再合并为 `target: 300`。

## 9. Usage API

`GET /api/token-usage` 每行增加 camelCase 字段：

```json
{
  "incomingModel": "gpt-5.6-sol",
  "model": "gpt-5.6-sol-fast"
}
```

历史记录返回：

```json
{
  "incomingModel": "",
  "model": "gpt-5.6-sol-fast"
}
```

API 不输出 `Legacy / Unknown` 文案；这是 Dashboard 表现层责任。

## 10. Dashboard

### 10.1 筛选

保留既有 routed model 筛选，并将标签明确为：

```text
Routed Model
```

新增独立筛选：

```text
Incoming Model
```

两者可同时使用：

```text
Incoming Model = gpt-5.6-sol
Routed Model   = gpt-5.6-sol-fast
```

历史 `incomingModel === ''` 显示为 `Legacy / Unknown`，并作为独立可选筛选值。

### 10.2 分布表

增加分组维度切换：

```text
By Routed Model
By Incoming Model
```

按 Incoming Model 分组时显示：

```text
Incoming Model      Routed Models        Requests  Tokens  Cost
```

同一 incoming model 在时间范围内若因规则变更对应多个 routed models，`Routed Models` 显示去重后的多个值，不假定一一对应。

### 10.3 图表

第一版不新增 incoming-model chart series grouping：

- Incoming Model 筛选会影响现有图表；
- 分布表支持 Incoming/Routed 分组；
- 现有图表 grouping 保持当前逻辑。

未来如果需要按 incoming model 展开折线，单独设计，不影响本次 storage/API 数据完整性。

### 10.4 CSV/导出

若当前 Usage 页面已有逐行 CSV/导出，则在现有导出中增加 incoming model 列；若当前没有导出，不新增导出功能。

## 11. Cardinality 与性能

- 未映射请求通常 `incomingModel === model`，不会额外拆分 bucket；
- 多个 aliases 指向同一 target 时才增加行数，这是正确 attribution 的必要代价；
- 仍按小时聚合，不转为逐请求存储；
- incoming model 长度遵循现有模型路由限制；
- API/Dashboard 聚合必须验证切换维度前后 totals 守恒。

## 12. 测试要求

### 12.1 Migration 与 Repository

使用真实 `bun:sqlite`，不使用 `mock.module()`：

- 历史行 migration 后 `incoming_model=''`；
- migration 重跑 no-op；
- schema baseline 只增加目标列/索引；
- 新行写入非空 incoming model；
- 两个 aliases 指向同一 model 时不合并；
- token 表与 request 表严格对齐；
- additive `record()` 正确；
- replacement `set()` 只删除对应 incoming bucket；
- 历史 unknown 行仍可 assemble；
- SQLite/D1 identity 完全一致。

### 12.2 请求与 Telemetry

覆盖：

- 未映射时 incoming 与 routed 相同；
- source alias → destination；
- 两个 source → 同一 destination；
- explicit pin 不进入 incoming model；
- Gemini compatibility normalization 在 incoming 采集之前；
- Responses continuation 使用当前外层 incoming model；
- server-tool 多轮保留外层 incoming model；
- provider correction 只改 modelKey/cost；
- Chat、Messages、Responses、Gemini、Embeddings、Images、Ollama；
- count-token 不创建 Usage。

### 12.3 API 与聚合

- incoming model 进入聚合键；
- 不同 incoming 不提前合并；
- 相同 incoming/routed/hour/client 正常合并；
- 历史 `''` 正常返回；
- request count 不倍增；
- routed 与 incoming 两种分组的 tokens/cost/requests totals 守恒。

### 12.4 Dashboard

- Incoming Model 独立筛选；
- Incoming + Routed 组合筛选；
- `Legacy / Unknown` 展示与筛选；
- 分布维度切换；
- 一个 incoming 对应多个 routed models；
- 总量、费用和请求数切换前后守恒；
- 现有导出存在时包含 incoming model。

## 13. 验收标准

1. 新请求始终保存非空 incoming model；历史行保持 `''`。
2. incoming model 是去 pin、协议规范化后、Key mapping 前的逻辑模型。
3. incoming/model/modelKey 三层身份在所有生成 Usage 的协议中保持明确且不互相覆盖。
4. 不同 incoming aliases 映射到同一 target 时，数据库和 API 均不提前合并。
5. usage 与 usage_requests 以完全相同的 incoming identity 聚合。
6. Dashboard 可独立或组合筛选 Incoming/Routed Model。
7. 分布表可切换 Incoming/Routed Model，切换前后总 requests/tokens/cost 守恒。
8. 历史 unknown 不做猜测回填，显示为 `Legacy / Unknown`。
9. Provider correction 与 server-tool 多轮不得改写 incoming model。
10. Migration、Repo、协议、API、Dashboard 和完整 CI 测试全部通过。
