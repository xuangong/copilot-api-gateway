# API Key 有序模型映射设计

**日期：** 2026-09-04  
**状态：** 已批准，待实施计划

## 1. 目标

为每个 API Key 增加一组可独立启用的有序模型映射。请求到达后，系统按列表自上而下运行一次，将当前模型名作为下一条规则的输入，从而支持链式改写。

默认配置为：

```text
Enabled: false
Mappings:
  gpt-5.6-sol → gpt-5.6-sol-fast
```

该默认值适用于现有 Key 和新建 Key。用户可在 Disabled 状态下编辑列表；删除默认项并保存后，系统不得在后续加载中自动补回。

## 2. 已确认的产品语义

### 2.1 启用状态

- 每个 Key 有独立的 `modelMappingsEnabled` 开关。
- 现有 Key 与新建 Key 默认 Disabled。
- Disabled 时完全跳过映射，保持当前请求行为。
- Disabled 时仍可新增、编辑、删除和排序映射。
- Enable/Disable 不清空列表。

### 2.2 匹配和执行

每项结构为：

```ts
interface ApiKeyModelMapping {
  source: string
  destination: string
}
```

规则如下：

1. source 使用去除首尾空格后的完整模型名精确匹配；不支持通配符、正则或前缀匹配。
2. 按列表自上而下完整运行一次。
3. 每一项最多运行一次；命中后将 destination 作为后续规则的当前模型。
4. 允许重复 source。
5. 允许 source 与 destination 相同。
6. 允许有限的往返规则，不做循环检测，因为列表不会从头重新执行。
7. 未命中时保持当前模型不变。

示例：

```text
规则：
1. a → b
2. b → a
3. a → c

请求：a
执行：a → b → a → c
结果：c
```

### 2.3 最终模型身份

映射完成后，最终 destination 被完全视为客户端直接请求的模型，不保留 source alias：

- 用最终模型选择 binding；
- 向 provider 转发最终模型；
- 按最终模型查询价格和扣减 quota；
- usage 的 `model` 与 `modelKey` 使用最终模型；
- Dashboard 归入最终模型；
- response body/SSE 使用最终模型语义。

请求 dump 可以按现有机制保留原始请求模型用于诊断，但不得把模型名或规则内容写入日志。

### 2.4 显式上游 pin

客户端显式指定的 `up_<id>/` pin 必须保留。映射只作用于模型主体：

```text
请求：up_123/gpt-5.6-sol
规则：gpt-5.6-sol → gpt-5.6-sol-fast
结果：up_123/gpt-5.6-sol-fast
```

如果 `up_123` 不提供最终 destination，则返回现有协议的 `model_not_found`，不得换用其他上游或回退 source。

### 2.5 模型目录

`/v1/models` 与 Key 设置页读取的原始可用模型目录保持不变：

- 不隐藏 source 或 destination；
- 不把 source 自动加入模型目录；
- source 可以是目录中不存在的自定义别名；
- destination 必须来自该 Key 当前可用模型；
- Key 映射不得写入或污染 upstream 模型缓存。

## 3. 方案选择

采用两个 Key 专用字段：

```text
model_mappings_enabled  INTEGER NOT NULL
model_mappings          TEXT NOT NULL  -- JSON array
```

不采用单独的 mapping 表，因为规则通常很少，单表会引入每请求 join/查询、排序事务和复杂默认回填。不采用通用 settings JSON，因为项目目前没有成熟的通用 settings 框架，会削弱类型、验证和局部更新语义。

## 4. 持久化和迁移

新增 `0007_api_key_model_mappings.sql`，不修改 baseline 或已有 migration：

```sql
ALTER TABLE api_keys
  ADD COLUMN model_mappings_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE api_keys
  ADD COLUMN model_mappings TEXT NOT NULL DEFAULT
  '[{"source":"gpt-5.6-sol","destination":"gpt-5.6-sol-fast"}]';
```

两个 default 都是 SQLite/D1 允许的常量 literal；JSON 作为普通 SQL TEXT 保存，不使用 JSON expression。

语义：

- 迁移为所有现有 Key 写入默认列表，开关保持 Disabled。
- 新 Key 使用相同默认列表和 Disabled 开关。
- 空列表保存为 `[]`，不得在 repo parser 或 GET serializer 中补回默认项。
- API 与 repo 必须保留数组顺序。

## 5. 数据类型和安全路由策略

`ApiKey` 墏加：

```ts
modelMappingsEnabled: boolean
modelMappings: ApiKeyModelMapping[]
```

API Key 鉴权本来就会按原始 Key 查询数据库。验证结果在现有最小投影上增加不含秘密的路由策略：

```ts
interface ValidatedApiKey {
  id: ApiKeyId
  name: string
  ownerId?: UserId
  routingPolicy: {
    modelMappingsEnabled: boolean
    modelMappings: ApiKeyModelMapping[]
  }
}
```

不得把完整 `ApiKey` 放入通用 Hono context，因为它还包含：

- 原始 API Key；
- Web Search/Jina credential；
- 其他与路由无关的敏感字段。

不为模型映射建立单独内存缓存。每次鉴权查询得到最新策略，保存后下一个请求立即生效，不需要解决 Docker 多进程、Cloudflare 多 isolate 和 L2 cache 的失效一致性。

## 6. 共享映射解析器

新增无 I/O 的纯函数，输入请求模型、开关和规则，输出以下不可变结构：

```ts
interface ResolvedKeyModel {
  requestedModel: string
  routedModel: string
  upstreamPin?: string
  matchedRuleIndexes: number[]
}
```

`matchedRuleIndexes` 仅供内部诊断/测试使用，不写日志，不进入外部 API。

执行顺序：

1. Disabled 或空规则：返回原模型；
2. 使用现有 `parseModelRouting` 语义分离 `up_<id>/` pin；
3. 对模型主体从上到下精确匹配并链式改写；
4. 完成后重新附加原 pin；
5. 不访问模型目录，不在解析器内选择 binding。

## 7. 协议接入

不能使用一个全局 HTTP middleware 原地改 JSON，因为 Gemini 的模型在 URL，image edits 可能是 multipart。采用“共享纯解析器 + 每协议 adapter”，统一在读取模型后、binding 选择前调用。

| 接口 | 模型来源 | 映射位置 |
|---|---|---|
| Anthropic Messages | JSON `model` | Messages binding 前 |
| OpenAI Responses | JSON `model` | Responses binding 前 |
| Chat Completions | JSON `model` | Chat binding 前 |
| Gemini generate/stream | URL `:model` | Gemini 现有名称规范化后、binding 前 |
| Anthropic count tokens | JSON `model` | tokenizer/binding 前 |
| Gemini count tokens | URL `:model` | translation/binding 前 |
| Embeddings | JSON `model` | binding 前，并改写上游 payload |
| Image generations | JSON `model` | binding 前，并改写上游 payload |
| Image edits | JSON 或 multipart `model` | binding 前，并替换转发 FormData 字段 |

通用数据流：

```text
读取客户端模型
→ 协议已有规范化（仅适用时）
→ 分离上游 pin
→ 按 Key 规则执行一次链式映射
→ 用最终模型选择 binding
→ 向上游发送最终模型
→ 按最终模型计价与统计
```

### 7.1 Gemini

Gemini 已有协议级别名与后缀处理，顺序固定为：

```text
URL 模型 → Gemini 现有规范化 → Key 映射 → binding
```

source 因而匹配规范化后的模型主体。

### 7.2 Responses 会话延续

`previous_response_id` 恢复出的模型也必须走同一映射函数。Key 设置变更后，下一次延续请求应用新规则。snapshot 和 usage 保存最终模型，不保留 source alias。

### 7.3 Image edits

multipart 请求必须在读取原始 model 后：

1. 保留原始 request dump；
2. 计算最终 routed model；
3. 用 routed model 选择 binding；
4. 重建转发 FormData 时用 routed model 替换且只保留一个 `model` 字段。

## 8. 模型可用性和错误行为

### 8.1 保存时

服务端在 PATCH 时重新验证 destination 属于该 Key 当前可用的原始模型目录。前端下拉不是安全边界。

### 8.2 请求时

模型可能在保存后下架或失去权限。仍严格执行：

```text
映射 → 尝试最终 destination → 当前协议的 model_not_found
```

不得：

- 回退 source；
- 忽略映射；
- 选择名称相近模型；
- 取消显式 upstream pin；
- 静默关闭规则。

## 9. 控制面 API

Key GET 响应增加：

```json
{
  "model_mappings_enabled": false,
  "model_mappings": [
    {
      "source": "gpt-5.6-sol",
      "destination": "gpt-5.6-sol-fast"
    }
  ]
}
```

遵循现有 Key API 的 dual-case contract，`keyToJson` 同时输出 `model_mappings_enabled` / `modelMappingsEnabled` 与 `model_mappings` / `modelMappings`。Dashboard 使用 snake_case；camelCase 供 llm-relay 及现有同类消费者兼容。PATCH 的写入 contract 仍只接受 snake_case，避免两个输入字段冲突。

PATCH 使用完整列表覆盖，开关与列表在一次 repo save 中原子更新：

```json
{
  "model_mappings_enabled": true,
  "model_mappings": [
    {
      "source": "gpt-5.6-sol",
      "destination": "gpt-5.6-sol-fast"
    }
  ]
}
```

`null` 不作为第三种长期状态：清空规则用 `[]`；关闭使用 `enabled: false`。

### 9.1 校验约束

服务端验证：

1. enabled 必须是 boolean；
2. mappings 必须是数组；
3. 每项只接受非空字符串 `source`、`destination`；
4. 两个字段 trim 后保存；
5. destination 必须为该 Key 当前可用模型；
6. source 可不在目录；
7. 保留重复 source 与数组顺序；
8. 最多 100 项；
9. 每个名称最多 256 字符；
10. 错误返回 `400`，包含具体条目索引和字段，但不得包含凭据。

## 10. Dashboard 设置面板

在 Key 详情页新增独立 `ModelMappingsPanel`，位于配置代码展示面板之前。

面板结构：

```text
Model mappings                                      [Disabled]
按列表顺序依次改写请求模型。关闭时仍可编辑规则。

Source model               Destination model             操作
[gpt-5.6-sol            ]  [gpt-5.6-sol-fast        ▾]  [↑][↓][删除]

[+ Add mapping]                                [Cancel] [Save]
```

交互：

- Source 使用自由文本输入；
- Destination 使用该 Key 原始可用模型下拉；
- 多 upstream 上的同名模型合并为一个 destination，辅助文字可列出可用 upstream；
- 保存值仅为纯模型名，不在规则中固化 upstream；
- 支持新增、编辑、删除、上移、下移；
- Disabled 状态允许完整编辑；
- 开关与列表共同构成 dirty state；
- Cancel 恢复最后一次服务端值；
- Save 成功后 reload Key 并显示服务端规范化结果；
- 已保存 destination 后续不可用时保留文本并标红 `Unavailable`，用户必须删除或重选后才能再次保存。

目标模型通过 `/api/models?keyId=<id>` 读取。映射后的 effective catalog 不替代这个原始 target catalog，也不得进入 upstream model cache。

## 11. 损坏配置的容错

数据库 JSON 可能因手工修改、旧版本或部分部署而损坏。repo parser 必须验证整个结构。

若出现：

- JSON 解析失败；
- 顶层不是数组；
- 任一项不是对象；
- 任一字段不是合法字符串；
- 项数或长度超限；

则整个映射策略安全降级为 Disabled，不部分执行有效项。结构化 warning 只记录允许的安全字段（失败类别、条目数量、内部引用的安全表示），不得记录 source、destination、请求模型或完整 Key 对象。

控制面返回安全的 Disabled 状态、空列表，并设置 `model_mappings_invalid: true`（camelCase alias 为 `modelMappingsInvalid`）；正常配置返回 `false`。用户重新保存后覆盖损坏值并清除该状态。该状态是读取时派生值，不新增数据库列。

## 12. Usage、价格和上游回显

映射后的最终模型必须贯穿 telemetry identity：

```text
model      = final destination public model
modelKey   = final destination/provider model key
upstream   = selected binding upstream
cost       = destination pricing snapshot
```

Copilot 可能在调用 `gpt-5.6-sol-fast` 后回显 `gpt-5.6-sol`。继续使用现有“调用方更具体模型优先”规则，不能让终态上游回显把 Fast 降级回 Sol。

任何 terminal model correction 都必须保持 `modelKey` 与 price snapshot 语义一致；若 correction 表示真正不同且价格不同的模型，应在共享 telemetry 边界重新解析价格，而不是只改 modelKey。

## 13. 测试计划

### 13.1 纯映射函数

覆盖：

- Disabled；
- 空列表；
- 默认映射；
- 未命中；
- 精确匹配；
- 链式映射；
- 重复 source；
- source=destination；
- 往返规则只执行一遍；
- 显式 upstream pin 保留；
- trim；
- 100 项边界；
- 损坏配置整体禁用。

### 13.2 Migration 与 repo

使用真实 `bun:sqlite`：

- fresh schema 包含新列；
- 旧 DB migration 后有默认规则且 Disabled；
- 新 Key 同样使用默认值；
- JSON round-trip 保留顺序和重复 source；
- `[]` 不补默认；
- Enable/Disable 不清空规则；
- full upsert 不丢字段；
- 损坏 JSON 不使鉴权路径崩溃；
- 更新 migration schema baseline。

禁止使用 Bun 1.3 中不可恢复的 `mock.module()`。

### 13.3 控制面

覆盖：

- GET 序列化；
- PATCH 原子保存；
- 所有校验错误；
- destination 当前不可用；
- owner/admin/assignee 权限；
- 安全路由 context 不泄漏完整 Key 或其他 credential。

### 13.4 协议端到端

验证每个 surface 的上游实际收到 destination：

- Messages；
- Responses；
- Chat Completions；
- Gemini generate/stream；
- Anthropic/Gemini count tokens；
- Embeddings；
- Image generations；
- JSON 与 multipart image edits。

至少覆盖：

```text
Anthropic Messages 请求 gpt-5.6-sol
→ Key 映射为 gpt-5.6-sol-fast
→ 实际走 Responses 上游
→ 返回合法 Anthropic SSE
```

并验证原始 dump、协议错误 envelope 和显式 pin 行为。

### 13.5 Usage 与 quota

覆盖：

- usage 只归入 destination；
- 不生成 source usage；
- modelKey 保留目标变体；
- target 的 input/read/write/output 单价；
- quota 记入调用 Key；
- upstream 回显 base id 不覆盖 Fast 身份。

### 13.6 Dashboard

覆盖：

- Disabled 状态可编辑；
- 默认一项；
- 开关保存；
- source 自由输入；
- destination 目录选择；
- 新增、编辑、删除、上移、下移；
- Cancel；
- unavailable 标记；
- 限制与错误提示；
- 保存后顺序不变。

## 14. 验收标准

1. 所有现有与新建 Key 默认 Disabled，列表含 `gpt-5.6-sol → gpt-5.6-sol-fast`。
2. Disabled 时所有协议行为与当前版本一致。
3. Enabled 后所有模型请求按列表自上而下完整运行一次。
4. 显式 upstream pin 被保留。
5. destination 不可用时严格失败，无隐式回退。
6. 所有路由、上游 payload、响应身份、价格、usage、quota 均使用最终 destination。
7. 模型目录保持原样，source alias 不被广告。
8. 设置保存后下一次请求立即生效，不依赖进程内缓存失效。
9. Dashboard 支持完整增删改、排序与 Disabled 状态编辑。
10. Migration、repo、控制面、协议、usage 与 UI 测试全部通过。
