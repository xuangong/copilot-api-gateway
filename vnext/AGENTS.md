# vNext Agent Guide

面向在 `vnext/` 里干活的 agent。老 `src/` 的规范在仓库根 `AGENTS.md`,这里只覆盖 vNext。

## 1. 快速启动

### 1.1 本地开发(Bun / Docker)

```sh
# 全量本地(带热更新)
cd vnext/apps/platform-bun
bun --hot src/server.ts        # 监听 41415

# Docker(和生产同拓扑)—— 从仓库根跑
cd /Users/zhangxian/projects/copilot-api-gateway
docker compose -f docker-compose.vnext.yml up -d
# 停机: docker compose -f docker-compose.vnext.yml down
# 只重启不重建: docker compose -f docker-compose.vnext.yml restart gateway-vnext
```

### 1.2 改代码后如何生效

| 场景 | 命令 |
|---|---|
| 只改后端 TS(non-Docker) | `bun --hot` 自动重载 |
| 只改后端 TS(Docker) | `docker compose -f docker-compose.vnext.yml build gateway-vnext && docker compose -f docker-compose.vnext.yml up -d gateway-vnext` |
| 改 dashboard(`apps/dashboard/`) | 同上,`build:ui` 会在 Dockerfile 里跑;non-Docker 需手动 `bun run build:ui` 后重启 server |
| 依赖变更(bun.lock 变) | 必须重新 `bun install`,Docker 场景要 `--no-cache` 重建 |
| 怀疑 layer 缓存吃错内容 | `docker compose -f docker-compose.vnext.yml build --no-cache gateway-vnext` |

### 1.3 部署位置

- **本地机器**(macOS 开发):`docker-compose.vnext.yml`,数据落 `./data-vnext/vnext.sqlite`
- **远程 SSH lab**:`ssh -i ~/lab_key.pem xian@20.193.231.97`,项目在 `/home/xian/dockers/copilot-api-gateway`
- **Cloudflare Workers**:`apps/platform-cloudflare` + `wrangler deploy`(仅在人明确要求时;vNext 期间禁止随意上 CFW)

## 2. Google OAuth 配置

Dashboard 登录用 Google OAuth,GHE Copilot 上游添加也依赖这一层。

### 2.1 环境变量

写 `.env`(仓库根,`docker-compose.vnext.yml` 会读):

```
GOOGLE_CLIENT_ID=938850799712-xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxx
# 可选(仅本地绕过 OAuth 直连 /v1/*,不要在生产用)
VNEXT_DEV_GITHUB_TOKEN=
VNEXT_DEV_COPILOT_TOKEN=
```

Client ID/Secret 从 [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) 拿。

### 2.2 Google Cloud Console 里必须做的两件事

1. **OAuth consent screen**:User Type 选 External;把要登录的 Google 邮箱加进 Test users。
2. **Authorized redirect URIs**:必须精确匹配后端拼出来的 URI(`google-routes.ts` 里 `${publicOrigin}/auth/google/callback`)。至少加这几条:
   - `http://localhost:41415/auth/google/callback`
   - 你远程 lab 的公网访问 URL,如 `http://20.193.231.97:41415/auth/google/callback`
   - CFW 域名的 `https://.../auth/google/callback`

漏了会看到 **"Access blocked: This app's request is invalid"** —— 100% 是这里没配对。

### 2.3 管理员账号

`packages/gateway/src/shared/config/constants.ts` 里 `ADMIN_EMAILS` 白名单决定谁登录后拿 `isAdmin`。当前:
```ts
export const ADMIN_EMAILS: readonly string[] = ["zhangxian1124@gmail.com", "test@local.dev"] as const
```

改这个常量后必须重建镜像。非 admin 邮箱首次登录会走"待审批"路径(见 `google-routes.ts`)。

## 3. 类型系统要求

`tsconfig.base.json` 全 workspace 打开:
- `strict: true`
- `noUncheckedIndexedAccess: true` — 数组/Record 访问都是 `T | undefined`,必须显式判空
- `noImplicitOverride: true`
- `verbatimModuleSyntax: true` — type-only import 必须 `import type`
- `isolatedModules: true`

硬性规则:

1. **禁止 `any`**。必须建具体接口或用 `unknown` + 类型守卫。审查 diff 时看到 `as any` 直接 reject。
2. **禁止 `@ts-ignore`/`@ts-expect-error`**,除非同一行注释说明为什么、指向哪个 issue,并且短期内可以清掉。
3. **禁止 `!` 非空断言**,除非能在 3 行内证明不可能是 `undefined`(附注释)。首选 early-return 或 `assert`。
4. **branded id 必须走 `branded-ids.ts`**。`UserId` / `GitHubAccountId` / `SessionToken` 等一律用 branded type 保证不会互串。不要 `as UserId` 直接强转 raw string,除非在明确的边界层(`google-routes.ts` 里从 DB 出来的一步)。
5. **依赖方向**(见 `vnext/README.md`):`@vibe-core/*` 内核不得依赖 `@vibe-llm/protocols`。由 `scripts/check-framework-purity.ts` 卡住,别绕过。
6. Provider 之间不互依赖,共享逻辑抽到 `provider-llm` 或 `chat-flow-kit`。
7. **Repo 层的可选 ownerId 必须显式处理**。历史 bug 复盘:`removeGithubAccount(userId, ownerId?)` 里 `ownerId ?? ''` 拼 upstream row id 会静默失败。任何 `ownerId?: UserId` 的分支都要在两条路径上都测过。

## 4. 测试要求

### 4.1 层次

| 层 | 位置 | 跑法 | 用什么 |
|---|---|---|---|
| Unit / repo / route | `packages/*/tests/` `packages/*/__tests__/` | `bun test` (从 `vnext/`) | `bun:test` |
| Framework purity | `scripts/check-framework-purity.ts` | 自动被 `bun test` 前置 | 静态导入分析 |
| SDK 集成 | 仓库根 `tests/sdk-*.test.ts` | 先另开 shell `bun run local`,再 `bun run test:integration:{openai,anthropic,gemini}` | 官方 SDK |
| Parity(vNext ↔ 旧版) | `vnext/scripts/parity/*.test.ts` | 手动,需要 `PARITY_*` env | bun:test |
| Wrangler dry-run | `bun run --filter '@vibe-llm/platform-cloudflare' deploy:dry` | CI 会跑 | wrangler |

### 4.2 硬性

- **PR 前必过 `bun run ci:local`** —— 打包了 purity + typecheck + test + lint + build:ui + wrangler dry-run。
- **新功能 = 新测试**。特别是 repo 层新分支、control-plane route、翻译器改动。
- **不要 mock `bun:sqlite`**。Bun 1.3 `mock.module()` 会跨文件泄漏(见 memory `bun_mock_module_unrestorable.md`),用真实 `SqliteRepo` + 临时 db 文件。
- **不要 mock 数据库调用做"通过"**。历史事故:mock 通过、prod migration 挂。测 repo 就用真实 sqlite。
- SDK 集成测试改动大时,同时对 OpenAI + Anthropic + Gemini 三边都跑一遍,防止翻译层单边回归。

### 4.3 覆盖点(改动清单必看)

改这些地方必须写/更新测试:

- `packages/gateway/src/control-plane/**` — 每个新 route 至少一条 happy path + 一条 auth 失败 case
- `packages/translate/**` — 每种协议对每种上游 kind 至少一个 fixture
- `packages/*repo*/**` — 加分支就加测试,尤其是 `ownerId?` 的两条路
- `apps/dashboard/src/**` 有业务逻辑的 hook — 抽出来单测,别把逻辑埋在 JSX

## 5. 开发规范

### 5.1 代码风格

- 2 空格缩进、双引号、无分号、ESM,和现有文件对齐
- 文件名 kebab-case(`github-routes.ts`),导出 camelCase / UPPER_SNAKE_CASE
- 内部导入优先 `~/` 或包名,不要相对路径穿包
- 注释只在**"为什么这样"**不明显时写(踩过的坑、上游怪癖、隐式约束)。别写"这段做什么" —— 让命名和类型说话

### 5.2 提交/PR

- Conventional Commits:`feat(vnext/gateway): …` / `fix(vnext/dashboard): …` / `docs(vnext): …`
- 一个 commit 一件事
- PR 描述里写清:用户可见影响、新增 env、新增 migration、跑过什么验证
- **vNext 期间禁止随意上 CFW**;要上必须人工点头(见 memory `spec8_execution_constraints.md`)
- Migration 只能**新增**(`migrations/00XX_*.sql`),不许改历史文件。D1 会按序应用,`deploy:full` 保证代码上线前 migration 已执行

### 5.3 日志与隐私

- 结构化日志。**禁止**把 user prompt / model output / token / API key / 邮箱 明文打进日志
- 需要打时用 mask helper(`email_mask`、`string_mask`)或只挑安全字段(operation、status、duration_ms)
- 前端不要 `console.log` 生产代码里留下来

### 5.4 环境切分

- 本地 sqlite(`./data-vnext/vnext.sqlite`) ≠ CFW D1。本地登录/账号不会自动同步到 prod
- 环境变量分层:`.env`(仓库根,docker compose 读) → 容器 `process.env` → `bootstrapBunPlatform` / `bootstrapCloudflarePlatform` 注入
- CFW 密钥用 `wrangler secret put`,不要写进代码或 wrangler.toml

## 6. 常见坑

去 memory 看 `common_pitfalls.md`。高频:

- **Docker image tag 错位**:手动 `docker build -t X` 用的 tag 和 compose 生成的 `copilot-api-gateway-gateway-vnext` 对不上,compose 重启还是老 image。永远用 `docker compose build` 而不是 `docker build`
- **BuildKit secret 缺失**:corp npmrc 通过 `secrets: [npmrc]` 挂进容器,`docker build` 直接跑会 401。走 compose
- **Upstream row id 硬编码**:`up_copilot_{ownerId}_{ghUserId}` 里 ownerId 拿错就静默删不掉。手工改 DB 的 `owner_id` 列后,主键 id 不会跟着改,后续 Re-auth 会创新行 —— 别手改,走 API
- **D1 migration drift**:先 push 代码后跑 migration → schema 报错。永远 `deploy:full`
- **`ownerId ?? ''` 陷阱**:任何 optional ownerId 的分支都要考虑 admin path 传 `undefined` 的情况
- **`bun test` 里 `mock.module`**:不要用,写测试用真实依赖 + 依赖注入
