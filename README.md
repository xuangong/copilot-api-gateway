# Copilot API Gateway

将 GitHub Copilot API 转换为标准 AI SDK 接口的网关代理。支持 **Anthropic**、**OpenAI**、**Google Gemini** 三大 SDK 直接对接，开箱即用。

基于 **Elysia + Bun** 构建，支持部署到 **Cloudflare Workers**（D1 + KV）或通过 **Docker** 自托管。

## 特性

- **多 SDK 兼容** — 同时支持 Anthropic Messages API、OpenAI Chat Completions / Responses API、Google Gemini API
- **多用户隔离** — Admin 通过邀请码邀请用户，每个用户独立绑定自己的 GitHub Copilot 账号，API key 和用量数据完全隔离
- **Web Search** — 内置 Web 搜索工具，支持 LangSearch / Tavily / Bing 三引擎自动降级
- **Dashboard** — 暗色风格管理面板，支持 GitHub 账号管理、API key 管理、用量统计、延迟监控
- **兼容性修复** — 自动处理 Copilot API 的 6 项兼容性问题（billing header、工具类型、thinking 块等）
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
| `POST /v1/responses` | Responses API | OpenAI SDK |
| `POST /chat/completions` | Chat Completions | OpenAI SDK |
| `POST /v1beta/models/{model}:generateContent` | Generate Content | Gemini SDK |
| `POST /v1beta/models/{model}:streamGenerateContent` | Stream Generate | Gemini SDK |
| `GET /v1/models` | 模型列表 | 通用 |

### Dashboard & 管理

| 端点 | 说明 |
|------|------|
| `GET /` | Dashboard 登录页 |
| `GET /dashboard` | 管理面板 |
| `POST /auth/login` | 登录（ADMIN_KEY / API key / 邀请码 / 会话 token） |
| `POST /auth/github` | GitHub Device Flow 绑定 |
| `GET /api/keys` | API key 列表 |
| `POST /api/keys` | 创建 API key |

## 使用示例

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

## 多用户系统

### 工作流程

1. **Admin** 使用 ADMIN_KEY 登录 Dashboard
2. **Admin** 在 Users 标签页生成邀请码（指定用户名称）
3. **用户** 使用邀请码登录 → 自动创建账号 → 获取会话 token
4. **用户** 在 Upstream 标签页通过 GitHub Device Flow 绑定自己的 Copilot 账号
5. **用户** 在 Keys 标签页创建 API key → 使用该 key 调用 AI API

### 隔离机制

- 每个用户只能看到自己的 GitHub 账号、API key、用量数据
- API key 绑定创建者的 Copilot 账号，调用时使用对应用户的 token
- Admin 可以查看所有用户、禁用/启用/删除用户
- 用户被禁用后，其所有 API key 和会话立即失效

## 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `ADMIN_KEY` | 管理员密钥，用于 Dashboard 登录 | 是 |
| `ACCOUNT_TYPE` | Copilot 账户类型：`individual` / `business` / `enterprise` | 否（默认 individual） |
| `LANGSEARCH_API_KEY` | LangSearch 搜索 API Key | 否 |
| `TAVILY_API_KEY` | Tavily 搜索 API Key | 否 |

## 兼容性处理

项目自动处理以下 Copilot API 兼容性问题：

1. **Billing Header 过滤** — 移除系统提示中触发计费校验的保留关键字
2. **工具类型转换** — 将 `type: "custom"` 转为标准 `type: "function"`
3. **Web Search 本地化** — 在网关层执行搜索，而非透传给上游
4. **Thinking 块清理** — 移除空的思考内容块
5. **无限空白检测** — 防止流式输出中的缓冲区溢出
6. **流式 ID 一致性** — 修复 Responses API 中 output_item ID 不匹配问题

## 项目结构

```
├── src/
│   ├── index.ts              # Cloudflare Workers 入口
│   ├── local.ts              # 本地开发入口（Bun + SQLite）
│   ├── config/               # 常量配置
│   ├── lib/                  # 核心库（认证、API key、GitHub、用量追踪）
│   ├── middleware/            # 中间件（请求头、用量统计）
│   ├── repo/                 # 数据层（D1 + SQLite 双实现）
│   ├── routes/               # API 路由
│   ├── services/
│   │   ├── copilot/          # Copilot API 转发
│   │   ├── gemini/           # Gemini 格式转换
│   │   ├── github/           # GitHub OAuth
│   │   └── web-search/       # Web 搜索（LangSearch / Tavily / Bing）
│   ├── transforms/           # 请求/响应兼容性转换
│   ├── storage/              # KV 存储抽象
│   └── ui/                   # Dashboard 前端（Alpine.js + Tailwind）
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

## License

MIT
