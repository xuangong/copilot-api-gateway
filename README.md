# Copilot API Gateway

GitHub Copilot API 代理，将 Copilot API 转换为标准的 Anthropic Messages API 和 OpenAI API 格式。

基于 **Elysia + Bun** 框架构建，支持部署到 **Cloudflare Workers**。

## 特性

- 🔄 **多 API 兼容**：支持 Anthropic Messages API、OpenAI Chat Completions、OpenAI Responses API
- 🔍 **Web Search**：内置 Web 搜索支持（LangSearch、Tavily、Bing 自动降级）
- 🛡️ **兼容性处理**：6 项 Copilot API 兼容性修复
- ☁️ **Cloudflare Workers**：零冷启动，全球边缘部署

## 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 获取 GitHub Token

```bash
bun run auth
```

按提示完成 GitHub Device Flow 认证。

### 3. 保存 Token 到本地 KV

```bash
# 将上一步获取的 token 保存到本地 KV
wrangler kv:key put --local --binding=KV github_token "YOUR_GITHUB_TOKEN"
```

### 4. 启动开发服务器

```bash
bun run dev
```

服务器默认运行在 `http://localhost:4141`

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /` | 健康检查 |
| `GET /v1/models` | 获取模型列表 |
| `POST /v1/messages` | Anthropic Messages API |
| `POST /v1/messages/count_tokens` | Token 计数 |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /chat/completions` | OpenAI Chat Completions |

## Web Search

支持在请求中使用 `web_search` 工具：

```json
{
  "model": "claude-sonnet-4",
  "messages": [{"role": "user", "content": "今天的新闻"}],
  "tools": [{"type": "web_search", "name": "web_search"}]
}
```

搜索引擎优先级：LangSearch → Tavily → Bing

配置 API Key（可选）：

```bash
# 设置为环境变量
wrangler secret put LANGSEARCH_API_KEY
wrangler secret put TAVILY_API_KEY
```

## 部署到 Cloudflare Workers

### 1. 创建 KV Namespace

```bash
wrangler kv:namespace create KV
```

复制输出的 `id` 到 `wrangler.toml`。

### 2. 设置 Secrets

```bash
wrangler secret put GITHUB_TOKEN
# 可选
wrangler secret put LANGSEARCH_API_KEY
wrangler secret put TAVILY_API_KEY
```

### 3. 部署

```bash
bun run deploy
```

## 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `GITHUB_TOKEN` | GitHub OAuth Token | 是 |
| `ACCOUNT_TYPE` | 账户类型：individual/business/enterprise | 否 |
| `LANGSEARCH_API_KEY` | LangSearch API Key | 否 |
| `TAVILY_API_KEY` | Tavily API Key | 否 |

## 兼容性处理

项目实现了以下 Copilot API 兼容性处理：

1. **x-anthropic-billing-header 过滤**：移除系统提示中的保留关键字
2. **自定义工具类型转换**：将 `type: "custom"` 转为 `type: "function"`
3. **web_search 工具处理**：本地执行 web search
4. **thinking 块清理**：移除空的思考块
5. **无限空白字符检测**：防止流式输出缓冲区溢出
6. **流式 ID 一致性修复**：修复 output_item ID 不一致问题

## 项目结构

```
src/
├── index.ts                # CF Workers 入口
├── config/                 # 配置
├── lib/                    # 核心库
├── storage/               # KV 存储抽象
├── services/
│   ├── github/            # GitHub 认证
│   ├── copilot/           # Copilot API 转发
│   └── web-search/        # Web 搜索
├── transforms/            # 兼容性转换
└── routes/                # API 路由
```

## License

MIT
