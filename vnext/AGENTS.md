# vNext Agent Guide

面向在 `vnext/` 里干活的 agent。老 `src/` 的规范在仓库根 `AGENTS.md`,这里只覆盖 vNext。

## 1. 快速启动

### 1.1 本地开发(Bun / Docker)

```sh
# 全量本地(带热更新)
cd vnext/apps/platform-bun
bun --hot src/server.ts        # 监听 8788(PORT 未设时的兜底);docker 里是 41414

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
   - `http://localhost:41414/auth/google/callback`
   - 你远程 lab 的公网访问 URL,如 `http://20.193.231.97:41414/auth/google/callback`
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

| 层 | 位置 / 命名 | 跑法 | 说明 |
|---|---|---|---|
| fast | 进程内的测试:纯单元、Hono `app.request`(含 `.e2e.`)、内存 SQLite(`.sqlite.`) | `bun run test:fast`(~80 s) | 本地改代码时的默认循环 |
| slow | `.proc.test.ts`(起真实子进程)、`.d1.test.ts`(Miniflare)、`.workerd.test.ts` | `bun run test:slow`(~20 s) | 名字决定分层,见 `scripts/test-tiers/` |
| research | `docs/superpowers/research/**/harness` | `bun run test:research` | 测量工具自身的测试 |
| isolation | 每个 fast 文件单独一个进程 | `bun run test:isolation`(~25 s) | 抓“只在全量里能过”的测试(依赖别的文件留下的平台单例) |
| Framework purity | `scripts/check-framework-purity.ts` | 自动被 `bun test` 前置 | 静态导入分析 |
| SDK 集成 | 仓库根 `tests/sdk-*.test.ts` | 先另开 shell `bun run local`,再 `bun run test:integration:{openai,anthropic,gemini}` | 官方 SDK |
| Parity(vNext ↔ 旧版) | `vnext/scripts/parity/*.test.ts` | 手动,需要 `PARITY_*` env | bun:test |
| Wrangler dry-run | `bun run --filter '@vibe-llm/platform-cloudflare' deploy:dry` | CI 会跑 | wrangler |

`bun test`(CI)仍然跑全部分层。本机 16 GB 内存在别的负载下,单进程全量偶尔会被 SIGKILL(exit 137),这时分层跑。

### 4.1.1 写测试的约定

- **平台**:每个测试文件自己调用 `setupTestPlatform()`(`packages/gateway/tests/_setup-platform.ts`),不要依赖别的文件留下的 repo / background / cache。`test:isolation` 会抓出来。
- **Repo**:用 `setupTestPlatform()` 返回的真实内存 SQLite repo,把行存进去,而不是手写 `… as unknown as Repo` 的假 repo。`tests/architecture/repo-fakes-ratchet.test.ts` 只允许这个数量下降;迁移一个文件就把 `MAX` 调低。
- **共享工具** `@vibe-core/test-utils`:`jsonResponse`、`sseResponse`、`collect`、`readBodyText`、`recordingFetcher`(可注入的 fetcher)、`withMockedFetch`、`createFetchStub`(文件顶层调用一次,每个测试后自动恢复全局 fetch)。不要再手写 `globalThis.fetch = …` 加手动恢复。
- **会起子进程的测试**必须命名为 `.proc.test.ts`(守卫:`scripts/test-tiers/tiers.test.ts`)。
- **时间边界**:构造 JWT / 过期时间这类用例时留足余量,不要用 `now + 1` 这种跨一秒就变合法的值。
- **测试要能因为有意义的原因失败**:不复述常量、不写被别的用例完全覆盖的用例;同形重复的用例改成一张表。

### 4.1.2 架构守卫

`packages/gateway/tests/architecture/`:

- `github-host-boundary`:gateway 源码不得写死 github.com 的 REST / OAuth 地址;GitHub 相关调用全部走 `@vibe-llm/provider-copilot/github`(按账号的 host,支持 `*.ghe.com`)。
- `provider-plugin-contract`:每个内置 provider 插件必须声明 `publicConfig`;并且对每个插件跑一致性套件 —— `normalizeConfig` 报错不回显凭据、不改输入;`probeConfig` 无效配置不发请求;`backup.verbatimConfig` 不带凭据;`catalog.modelEndpoints` 能处理最简模型条目。新 provider 注册即继承这些检查。
- `provider-kind-branches-ratchet`:gateway 源码里 `provider === "copilot"` 这类按种类的字面量比较只许减少。provider 专属行为放到插件钩子里:`publicConfig` / `normalizeConfig` / `probeConfig` / `backup` / `catalog` / `opaqueAffinity` / `syncView`(定义在 `packages/provider-llm/src/plugin.ts`)。
- `repo-fakes-ratchet`:手写 `… as unknown as Repo` 只剩 2 处有意保留的(共享路由夹具、一处故障注入),不许增加。

`packages/translate/tests/translation-pair-coverage.test.ts`:每个翻译对的 `request` / `body` / `events` 模块都必须在 `tests/<pair>/` 下有同名测试。

### 4.2 硬性

- **PR 前必过 `bun run ci:local`** —— 打包了 purity + typecheck + test + test:isolation + lint + build:ui + wrangler dry-run。
- **新功能 = 新测试**。特别是 repo 层新分支、control-plane route、翻译器改动。
- **不要 mock `bun:sqlite`**。Bun 1.3 `mock.module()` 会跨文件泄漏(见 memory `bun_mock_module_unrestorable.md`),用真实 `SqliteRepo`(`setupTestPlatform()` 的内存库)。
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

## 7. 跟进参考项目(copilot-gateway)

参考项目在 `../copilot-gateway`。跟进方法见 `docs/superpowers/plans/2026-11-19-reference-gap-adoption.md`:

- 参考的代码形状不是规格,它**为什么改**才是:先读提交说明、PR 和测试,写下“输入 → 期望输出”的验收标准。
- 验收测试必须在旧代码上失败、在新代码上通过;测试里注明参考提交号。
- 修这一类问题,而不只是这一个输入(共享函数 + 守卫测试)。
- 改所有用户默认行为的是**策略**,不是 bug。先调研同类网关(LiteLLM、Portkey、new-api、OpenRouter、CLIProxyAPI、Vercel AI SDK 等)的做法和理由,按业界共识定,并把结论和出处写进测试注释和计划文档。
- 上次对齐到参考 `ab7d27239`(#751,2026-11-19)。
