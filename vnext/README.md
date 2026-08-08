# vNext

下一代网关重构。旧 `src/` 已下线,vNext 承担生产流量。

## 结构

```
vnext/
├── apps/
│   ├── platform-bun/         # Bun/Docker 入口 (bootstrapBunPlatform)
│   ├── platform-cloudflare/  # Cloudflare Workers 入口 (wrangler)
│   └── dashboard/            # React 19 dashboard(嵌入 gateway 的 UI)
└── packages/                 # 19 个包
    ├── protocols-llm/        # LLM 协议 schemas + 类型 (纯)
    ├── translate/            # 协议翻译器 (纯函数)
    ├── result/               # ProtocolFrame + 结果代数 (纯)
    ├── service/              # Interceptor 中间件 (纯)
    ├── chat-flow-kit/        # 数据面组装工具 (纯)
    ├── upstream/             # UpstreamRecord 泛型 (纯)
    ├── upstream-repo/        # UpstreamRepo 抽象 + 惰性访问器
    ├── responses-store/      # /v1/responses previous_response_id 存储
    ├── cache/                # KV / D1 缓存抽象
    ├── http/                 # 出向 HTTP + fetchWithRetry
    ├── platform/             # 运行时 singleton (waitUntil / DB / files)
    ├── provider-llm/         # LlmModelProvider 契约
    ├── provider-copilot/     # GitHub Copilot upstream
    ├── provider-azure/       # Azure OpenAI upstream
    ├── provider-custom/      # OpenAI 兼容自定义 upstream
    ├── provider-sdf/         # SDF upstream
    ├── provider-codex/       # ChatGPT Codex upstream (Responses 原生 + compact)
    ├── provider-claude-code/ # Claude Code subscription upstream (Messages 原生)
    └── gateway/              # 数据面路由 + attempt.ts + boundary chain
```

## 依赖方向(核心不可违反)

```
result ← service ← protocols-llm ← translate
                        ↑
                        └── provider-llm ← provider-* ← gateway
                        └── upstream ← upstream-repo
```

- `@vibe-core/*` 是运行时无关内核 —— **不得**依赖 `@vibe-llm/protocols`(由 `scripts/check-framework-purity.ts` 校验)
- provider 之间不互相依赖;都实现 `LlmModelProvider`
- gateway 是唯一装配点

## 常用命令

```sh
cd vnext

# 依赖
bun install

# 单项 gate
bun run typecheck        # 全部 workspace 的 tsc --noEmit
bun test                 # 全部 bun:test(含 framework-purity 前置)
bun run lint             # eslint .
bun run build:ui         # 构建 dashboard,产物落到 gateway/shared/edge/ui-pages/
bun run --filter '@vibe-llm/platform-cloudflare' deploy:dry
                         # wrangler dry-run,不上线

# 一键本地 CI
bun run ci:local         # purity + typecheck + test + lint + build:ui + wrangler dry-run
```

## 入口

- **Bun / Docker**:`apps/platform-bun` — `bootstrapBunPlatform()` 装配 SQLite + local file provider + `waitUntil` no-op
- **Cloudflare Workers**:`apps/platform-cloudflare` — `bootstrapCloudflarePlatform(env, ctx)` 装配 D1 + KV file provider + `ctx.waitUntil`

Gateway 代码从 `@vibe-core/platform` 消费 singleton,业务层不感知平台差异。

## 客户端 SDK 兼容

Gateway 接受下列 client shapes(与 upstream 类型正交):

- OpenAI SDK (`/v1/chat/completions`, `/v1/responses`, `/v1/responses/compact`, `/v1/embeddings`, `/v1/models`)
- Anthropic SDK (`/v1/messages`, `/v1/messages/count_tokens`)
- Google Gemini SDK (`/v1beta/models/*:generateContent`, `:streamGenerateContent`)

Upstream(provider) kind 与 client protocol 由数据面 attempt.ts 翻译打通。

## GHE 数据驻留租户 token 提取

`msft.ghe.com` 这类租户跑不了 Device Flow,走 Paste Token 路径。工具在 `vnext/tools/extract-vscode-github-token.ts`,读 macOS Keychain + VS Code `state.vscdb` 解出已登录的 GitHub token。

前置(硬性): **macOS + VS Code 已用目标 GHE 账号登录成功过一次 + 首跑允许 Keychain 授权**。

```sh
bun run vnext/tools/extract-vscode-github-token.ts --host msft.ghe.com
# Insiders: --edition insiders    JSON 输出: --json    调试: --verbose
```

完整流程(前置检查、Dashboard 绑定、CLI 直调)见仓库根 [`README.md` → GHE 数据驻留租户](../README.md#ghe-数据驻留租户paste-token-流程)。

## 状态

**2026-08-05**:vNext 承担全部生产流量,`ci:local` 全绿。CFW 部署走 `apps/platform-cloudflare` 的 wrangler;Docker 走 `apps/platform-bun`。GitHub Actions:
- `.github/workflows/vnext-ci.yml` —— push / PR 自动跑本地 gate(purity + typecheck + test + lint + build:ui + wrangler dry-run),无需 secrets。
- `.github/workflows/vnext-remote-compat.yml` —— 手动 `workflow_dispatch`,凭 `VNEXT_BASE_URL` / `ROOT_BASE_URL` / `TEST_API_KEY` 跑 Anthropic + OpenAI + Gemini SDK 双跑 + 数据面 parity dual-smoke;缺 secret 时输出显式 skipped summary,不伪造 pass。CFW 生产上线仍由用户手动触发。
