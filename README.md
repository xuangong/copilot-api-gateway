# Copilot API Gateway

将 GitHub Copilot API 转换为标准 AI SDK 接口的网关代理。让 **Claude Code**、**Codex CLI**、**Gemini CLI** 三大 AI 编程工具直接使用你的 GitHub Copilot 订阅，无需额外 API 费用。

基于 **Elysia + Bun** 构建，支持部署到 **Cloudflare Workers**（D1 + KV）或通过 **Docker** 自托管。

## 特性

- **三大 CLI 直连** — Claude Code、OpenAI Codex CLI、Google Gemini CLI 开箱即用
- **多 SDK 兼容** — 同时支持 Anthropic Messages API、OpenAI Chat Completions / Responses API、Google Gemini API
- **多用户隔离** — Admin 通过邀请码邀请用户，每个用户独立绑定自己的 GitHub Copilot 账号，API key 和用量数据完全隔离
- **Web Search** — 内置 Web 搜索工具，支持 LangSearch / Tavily / Bing 三引擎自动降级
- **Dashboard** — 双主题管理面板（Midnight Aurora 暗色 / Clean White 亮色），支持：
  - GitHub 账号管理（Admin 可查看所有用户的 GitHub 账号）
  - API key 管理（创建、删除、轮换、重命名）
  - 用量统计 — 多维度筛选（User / Key / Client / Model），分布图 + 趋势图
  - 延迟监控 — 按模型筛选，Stream/Sync 分离，按 Colo 分布
  - 三大 CLI 配置指引（含推荐模型选择）
  - 数据导入导出
- **Per-Key Quota** — 每个 API key 可设日级别配额（Requests/Day + Weighted Tokens/Day），超限返回 429；Dashboard 实时展示配额进度
- **Prompt Caching** — 透传 Anthropic prompt cache 控制，dashboard 展示 Cache Read / Cache Creation / 缓存命中率
- **兼容性修复** — 自动处理 Copilot API 的兼容性问题（billing header、工具类型、thinking 块、Gemini model mapping 等）
- **双部署模式** — Cloudflare Workers（全球边缘 + Smart Placement）或 Docker 自托管
- **SDK 集成测试** — 适配自官方 SDK 仓库的测试用例，确保真实兼容性

## 快速开始

### Cloudflare Workers 部署

```bash
# 1. 安装依赖
bun install

# 2. 创建 D1 数据库和 KV 命名空间
wrangler d1 create copilot-db
wrangler kv:namespace create KV
# 将输出的 ID 更新到 wrangler.toml

# 3. 执行数据库迁移
wrangler d1 migrations apply copilot-db --remote

# 4. 设置管理员密钥
echo -n "your_admin_key" | wrangler secret put ADMIN_KEY

# 5. 部署
bun run deploy
```

部署完成后访问 Dashboard，使用 ADMIN_KEY 登录，通过 GitHub Device Flow 绑定 Copilot 账号。

### Docker 部署

```bash
# 使用 docker compose
ADMIN_KEY=your_admin_key docker compose up -d
```

数据持久化在 `./data` 目录，使用 SQLite 存储。

### 本地开发

```bash
bun install
bun run local:watch    # 热重载开发服务器，端口 41414
```

## API 端点

### AI SDK 接口

| 端点 | 说明 | SDK |
|------|------|-----|
| `POST /v1/messages` | Messages API | Anthropic SDK |
| `POST /v1/messages/count_tokens` | Token 计数 | Anthropic SDK |
| `POST /v1/responses` | Responses API | OpenAI SDK / Codex CLI |
| `POST /responses` | Responses API（无 /v1 前缀） | Codex CLI |
| `POST /chat/completions` | Chat Completions | OpenAI SDK |
| `POST /v1beta/models/{model}:generateContent` | Generate Content | Gemini SDK |
| `POST /v1beta/models/{model}:streamGenerateContent` | Stream Generate | Gemini SDK |
| `GET /v1/models` | 模型列表 | 通用 |

### Dashboard & 管理

| 端点 | 说明 |
|------|------|
| `GET /` | Dashboard 登录页 |
| `GET /dashboard` | 管理面板 |
| `POST /auth/login` | 登录（ADMIN_KEY / User Key / API key / 邀请码） |
| `POST /auth/register` | 邀请码注册（设置 User Key） |
| `POST /auth/github` | GitHub Device Flow 绑定 |
| `GET /api/keys` | API key 列表 |
| `POST /api/keys` | 创建 API key |
| `GET /api/token-usage` | 用量统计查询 |
| `GET /api/latency` | 延迟数据查询 |
| `GET /api/export` | 数据导出（Admin） |
| `POST /api/import` | 数据导入（Admin） |

## CLI 工具配置

部署完成后，在 Dashboard 的 **API Keys → Configuration** 可以看到每个 CLI 工具的完整配置。以下是快速参考：

### Claude Code

```bash
export ANTHROPIC_BASE_URL=https://your-gateway.workers.dev
export ANTHROPIC_AUTH_TOKEN=your-api-key
export ANTHROPIC_MODEL=claude-sonnet-4-20250514
export ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5-20251001
```

### Codex CLI

`~/.codex/config.toml`:

```toml
model = "gpt-4.1"
model_provider = "copilot_gateway"

[model_providers.copilot_gateway]
name = "Copilot Gateway"
base_url = "https://your-gateway.workers.dev/"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

```bash
export OPENAI_API_KEY=your-api-key
```

### Gemini CLI

```bash
export GEMINI_API_KEY=your-api-key
export GEMINI_API_BASE_URL=https://your-gateway.workers.dev
```

## SDK 使用示例

### Anthropic SDK

```typescript
import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({
  apiKey: "your-api-key",
  baseURL: "https://your-gateway.workers.dev/v1",
})

const message = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
})
```

### OpenAI SDK

```typescript
import OpenAI from "openai"

const client = new OpenAI({
  apiKey: "your-api-key",
  baseURL: "https://your-gateway.workers.dev",
})

const completion = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
})
```

### Gemini SDK

```typescript
import { GoogleGenAI } from "@google/genai"

const ai = new GoogleGenAI({
  apiKey: "your-api-key",
  httpOptions: { baseUrl: "https://your-gateway.workers.dev" },
})

const response = await ai.models.generateContent({
  model: "gemini-2.0-flash",
  contents: "Hello!",
})
```

### Web Search

在 Anthropic Messages API 中使用 `web_search` 工具：

```json
{
  "model": "claude-sonnet-4-20250514",
  "messages": [{ "role": "user", "content": "今天的科技新闻" }],
  "tools": [{ "type": "web_search", "name": "web_search" }]
}
```

搜索引擎优先级：LangSearch → Tavily → Bing（免费，无需 API key）

## Per-Key Quota

每个 API key 支持设置日级别配额限制，默认不设配额 = 无限制。

- **Requests/Day** — 每日请求次数上限（UTC 日）
- **Weighted Tokens/Day** — 每日加权 Token 用量上限，计算公式：
  ```
  Weighted Tokens = (Cache Read × 10%) + (Input × 100%) + (Output × 500%)
  ```

通过 Dashboard Keys 标签页的 Quota 面板编辑，或通过 API：

```bash
# 设置配额
curl -X PATCH https://your-gateway/api/keys/{id} \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"quota_requests_per_day": 1000, "quota_tokens_per_day": 500000}'

# 取消配额（设为 null = 无限制）
curl -X PATCH https://your-gateway/api/keys/{id} \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"quota_requests_per_day": null, "quota_tokens_per_day": null}'
```

超出配额时，API 返回 HTTP 429 和对应错误信息。

## 多用户系统

### 工作流程

1. **Admin** 使用 ADMIN_KEY 登录 Dashboard
2. **Admin** 在 Users 标签页生成邀请码（指定用户名称）
3. **用户** 使用邀请码登录 → 设置 User Key → 自动创建账号
4. **用户** 在 Upstream 标签页通过 GitHub Device Flow 绑定自己的 Copilot 账号
5. **用户** 在 Keys 标签页创建 API key → 使用该 key 调用 AI API

### 隔离机制

- 每个用户只能看到自己的 GitHub 账号、API key、用量数据
- API key 绑定创建者的 Copilot 账号，调用时使用对应用户的 token
- Admin 可以查看所有用户、GitHub 账号、禁用/启用/删除用户
- Admin 用量统计页可按 User 维度查看分布
- 用户被禁用后，其所有 API key 无法调用 AI API（Dashboard 仍可登录查看）；重新启用后立即恢复
- 用户被删除后，其所有 API key、GitHub 账号、会话数据一并清除

## Dashboard

双主题设计，跟随系统偏好或手动切换：

- **Midnight Aurora**（暗色）— 深邃背景 + 极光渐变高光
- **Clean White**（亮色）— 纯净白底 + 高对比强调色
- **移动端适配** — 导航栏横向滚动、表格横向滚动、筛选器自动堆叠对齐、统计网格自适应列数

### 用量分析

- 多维度正交筛选：User / Key / Client / Model
- 选中某个维度作为筛选条件，其余维度展示分布
- 支持 Today / 7 Days / 30 Days / Week（ISO 自然周导航）时间范围
- Cache 统计：Cache Read Tokens、Uncached Input Tokens、缓存命中率
- 每个维度显示堆叠分布条（Hover 显示百分比）和详细表格

### 延迟监控

- Stream / Sync 双曲线趋势图
- 按模型筛选
- 按类型和数据中心分布统计
- Token Miss Rate 监控

## 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `ADMIN_KEY` | 管理员密钥，用于 Dashboard 登录 | 是 |
| `ACCOUNT_TYPE` | Copilot 账户类型：`individual` / `business` / `enterprise` | 否（默认 individual） |
| `LANGSEARCH_API_KEY` | LangSearch 搜索 API Key | 否 |
| `TAVILY_API_KEY` | Tavily 搜索 API Key | 否 |

## 兼容性处理

项目自动处理以下兼容性问题：

1. **Billing Header 过滤** — 移除系统提示中触发计费校验的保留关键字
2. **工具类型转换** — 将 `type: "custom"` 转为标准 `type: "function"`
3. **Web Search 本地化** — 在网关层执行搜索，而非透传给上游
4. **Thinking 块清理** — 移除空的思考内容块
5. **Cache Scope 过滤** — 仅移除上游不支持的 `cache_control.scope` 字段，保留 prompt caching 功能
6. **无限空白检测** — 防止流式输出中的缓冲区溢出
7. **流式 ID 一致性** — 修复 Responses API 中 output_item ID 不匹配问题
8. **Gemini 模型映射** — `gemini-2.5-flash-lite` → `gemini-3-flash-preview` 等不支持型号自动映射
9. **Gemini `-customtools` 后缀** — 自动剥离 Gemini CLI 追加的 `-customtools` 模型后缀
10. **空工具参数修复** — Gemini CLI 发送的 `parameters: {}` 自动补全为有效 JSON Schema
11. **SSE 分块缓冲** — 跨 TCP 包的 SSE 事件正确缓冲，防止 chunk 边界截断

## 项目结构

```
├── src/
│   ├── index.ts              # Cloudflare Workers 入口
│   ├── local.ts              # 本地开发入口（Bun + SQLite）
│   ├── config/               # 常量配置
│   ├── lib/                  # 核心库（认证、API key、GitHub、用量追踪、SSE 缓冲）
│   ├── middleware/            # 中间件（请求头、用量统计）
│   ├── repo/                 # 数据层（D1 + SQLite 双实现）
│   ├── routes/               # API 路由
│   ├── services/
│   │   ├── copilot/          # Copilot API 转发
│   │   ├── gemini/           # Gemini 格式转换（模型映射、工具参数修复）
│   │   ├── responses/        # Responses API ↔ Chat Completions 格式转换
│   │   ├── github/           # GitHub OAuth
│   │   └── web-search/       # Web 搜索（LangSearch / Tavily / Bing）
│   ├── transforms/           # 请求/响应兼容性转换
│   ├── storage/              # KV 存储抽象
│   └── ui/                   # Dashboard 前端（Alpine.js + Tailwind + Chart.js）
├── migrations/               # D1 数据库迁移
├── tests/                    # SDK 集成测试
├── Dockerfile                # Docker 构建
├── docker-compose.yml        # Docker Compose 配置
└── wrangler.toml             # Cloudflare Workers 配置
```

## 测试

```bash
# 单元测试
bun test

# SDK 集成测试（需要先启动本地服务器）
bun run local &
bun run test:integration              # 全部
bun run test:integration:anthropic    # Anthropic SDK
bun run test:integration:openai       # OpenAI SDK
bun run test:integration:gemini       # Gemini SDK
```

### Gemini long-running streams

`/v1beta/models/<model>:streamGenerateContent` 支持两种流格式：

- `?alt=sse`（推荐）：标准 SSE，网关会在 idle > 15s 时注入 `: keepalive` 心
  跳，避免 Cloudflare 边缘在 ~60s 后关闭空闲连接。Gemini CLI 默认走这条。
- `alt=json`（默认）：JSON 数组流。**不支持心跳** —— 协议没有合法 noop 字节，
  插任何东西都会导致客户端 `JSON.parse` 失败。如果你的请求会触发长 thinking 或
  长工具推理，请显式带上 `?alt=sse`。

## License

MIT
