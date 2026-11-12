# 交接：Dashboard 重设计的收尾工作（2026-11-12）

这份文档给在另一台机器上接手的人（或 agent）看，说明已经完成了什么、还剩什么、怎么做和怎么验证。只读这一份就能开工；涉及的其他文档都写明了路径。

## 1. 当前状态

### 已完成

Dashboard 整体重设计的三期都已完成并上线：

| 阶段 | 内容 | 计划文档 |
|---|---|---|
| 第一期 | 底座和外框：设计 token、Geist 字体、`src/ui` 组件库、分组侧栏 | `docs/superpowers/plans/2026-11-11-dashboard-redesign-phase1.md` |
| 第二期 | 全部页面迁到新组件：用量/延迟、API Keys、上游、模型/定价、用户/代理/中继/设置/Agent Remote | `docs/superpowers/plans/2026-11-11-dashboard-redesign-phase2-*.md` |
| 第三期 | 服务端页面（登录、设备授权、指南）只同步颜色和字体 | `docs/superpowers/plans/2026-11-12-dashboard-redesign-phase3-server-pages.md` |

设计规格：`docs/superpowers/specs/2026-11-11-dashboard-redesign-design.md`。

另外做掉的：

- 安全类修复（`57f412c6`）：
  - 聊天错误条的 Retry 不再重复发送；
  - 代理删除、Agent Remote 撤销、导入 Replace 加了确认；
  - 管理员不能禁用或删除自己，界面和服务端都有拦截。
- 服务端页面收尾（`a17e8961`）：
  - 认证错误页 `errorPage()` 换新样式，并加上 noindex；
  - 删掉空的光晕元素和不用的 Prism CDN 映射，三个页面加了 meta description；
  - 新增 `packages/gateway/tests/ui-pages-token-parity.test.ts`。服务端页面的颜色值是从 dashboard 手工复制的，这个测试保证两边一致。
- 测试稳定性（`fd7fa8bf`、`d66d04e9`）：修了 4 个在机器繁忙时超时或失败的测试，详见第 4.3 节。

### 线上版本

| 环境 | 版本 |
|---|---|
| 本地 Docker、SSH lab | release `fd7fa8bf-followups-20261111T192454Z` |
| Cloudflare Workers | version `ea875f3c` |

`d66d04e9` 和这份文档只改了测试和文档，不需要部署。

### 质量基线

在 `vnext/` 下跑 `bun run ci:local`：

- 7163 个测试，0 失败；
- lint 0 error，有 38 个原有 warning；
- 类型检查、构建、Cloudflare dry-run 全部通过。

dashboard 各页面在浅色、深色主题下，Lighthouse 无障碍都是 100。

## 2. 新机器准备

```bash
git clone <repo> && cd copilot-api-gateway && git checkout vNext
cd vnext
bun --version            # CI 固定 1.3.0，本机用同版本
bun install --frozen-lockfile
bun run build:setup && bun run build:ui
bun run ci:local         # 约 3-5 分钟，作为开工前的基线
```

注意：

- **不要把镜像源地址提交进 `bun.lock`。** 如果 npm 源不通，可以临时用 `BUN_CONFIG_REGISTRY=<镜像> bun install --frozen-lockfile`。lockfile 里的下载地址必须保持为空字符串。
- **测试必须在 `vnext/` 目录下跑。**
- **reference-adapter 测试依赖一份本地快照。**
  - 文件 `docs/superpowers/research/2026-10-07-reference-stage-measurement/harness/reference-adapter.test.ts` 默认从原机器上的一个路径读取参考项目快照（固定在参考仓库的 `1d7dcd92`）。
  - 新机器上没有这份快照，这些测试会失败。
  - 处理方法：设置环境变量 `REFERENCE_SOURCE_ROOT`，指向参考仓库在 `1d7dcd92` 的一份 checkout。
  - 不要指向参考仓库的最新版。它的迁移 0096 删掉了 `users.upstream_ids`，和测试不兼容。
  - 新机器上 CI 出现这类失败属于环境问题，与代码无关。

## 3. 工作约定（项目所有者的要求，必须遵守）

- **与用户沟通一律用中文。**
- **提交、合并、推送、部署前都要先问用户。** 某一次的批准不代表下一次也批准。只有用户明确说"部署"才部署，默认三个环境一起部署。
- **改代码的流程：**
  1. 在 `.worktrees/` 下新建分支工作，不要直接在 vNext 上改；
  2. 先写计划，放在 `docs/superpowers/plans/`；
  3. 实现；
  4. 代码评审；
  5. 浏览器走查；
  6. 跑完整的 `bun run ci:local`；
  7. 用中文汇报；
  8. 问用户是否提交和部署。
- **重设计相关的硬约束：**
  - 现有功能必须全部保留；
  - 不改用户可见的文案，只有新增的、读屏专用的 aria 文案除外；
  - 代码里的字形和 emoji 可以换成 lucide 图标。
- **i18n：**
  - 文案在 `packages/gateway/src/shared/edge/ui-pages/i18n.ts`；
  - 新增的 key 用双引号，中文和英文字典都要加；
  - 加完跑 `bun test packages/gateway/tests/i18n-keys.test.ts`。
- **前端写法：** 只用 `src/ui` 里的组件和语义 token：
  - 背景：`bg-background`、`bg-panel`、`bg-muted`
  - 文字：`text-fg`、`text-fg-muted`、`text-fg-subtle`
  - 边框：`border-border`、`border-input`
  - 品牌色：`bg-brand`、`text-brand-text`
  - 状态色：`text-success`、`text-warn`、`text-danger`，以及它们的 `*-text` 变体

  不要再用 `accent-*` 或 v3 色板的色名。
- **Tailwind 4 的坑：** 全局的 `input[type=…]` 规则不在任何 layer 里，会盖过工具类。不要用 `!` 去硬顶，改为给 input 包一层。
- **禁止：**
  - 绕过 git hooks（`--no-verify`）；
  - 不带名字的 `git stash`；
  - 在日志或输出里打印 API key、token 或其他密钥；
  - 对生产 D1 做 SELECT 以外的操作，或读取凭据列。
- **GitHub Actions 不要处理。** 仓库所在账号因账单问题被锁，CI 一直没有运行。这是所有者明确说"不要处理"的事项，以 `bun run ci:local` 作为质量门禁。

## 4. 剩余任务

按建议顺序排列。每一项开工前都先和用户确认范围。

### 4.1 i18n 和文案整理（需要用户先批准措辞）

下面这些是重设计期间刻意没动的文案问题。要改可见文字，必须先把拟用的中英文措辞给用户确认，再动代码。

- **原生 `confirm()` 里写死的英文（7 处）：**
  - `apps/dashboard/src/state/keys.ts:116`
  - `state/upstreams.ts:155,164,173`
  - `state/users.ts:97,111`

  建议改成 i18n key，并改用 `src/ui/dialog` 做确认框。代理、Agent Remote、Settings 的 `confirm` 已经接入 i18n，可以参考。
- **写死的英文 toast：** `state/upstreams.ts` 里的 `{name}: N models`、`probe failed`、`Deleted …`、`Signed out …`，用户页的 `Deleted …` 也一样。
- **侧栏和页面名称不一致：**
  - 侧栏写的是 "Agent Remote"，写死在 `apps/dashboard/src/components/AgentRemoteEntry.tsx:21,25`；
  - 页面标题和面包屑用的是 "Agent Hosts"（`dash.remote.title`，中文也没翻译）；
  - 需要统一成一个名字。
- **面包屑显示 "Models / Models"：** 分组名和页面名都用了 `dash.models`（`shell/navigation.ts:50`）。
- **日期和时间格式写死成 `en-US`，相对时间 `timeAgo` 写死英文：**
  - `tabs/clients/ClientsTab.tsx`
  - `tabs/keys/helpers.ts`
  - `state/usage.ts`、`state/usage-strip.ts`、`state/latency.ts`、`state/time-buckets.ts`
  - `api/users.ts`
- **其余写死的英文：**
  - 用量页："Previous/Next day"、"Cache"、" req"、"tok/s"、"This week"、"n="；
  - 模型页："Searched/Searching"、"Loading…"、"TTFT"、"OpenAI Embeddings"、"System One / OpenAI Decisions"；
  - 上游页：刷新按钮的 title "Refresh"、"(unknown)"、设备授权里的 "copy"。
- **读屏名称重复：**
  - 用量页两个 routed/incoming 切换都用 `dash.modelDistributionToggle`；
  - 联网搜索两个选择框都叫 "Passthrough"；
  - 都需要各自单独的 aria 文案。
- **`dash.wsLinkUnavailable` 文案里带了 "↗" 字形**，改文案时去掉。

### 4.2 界面遗留（不改文案，可以直接做）

- **字号偏小：**
  - `apps/dashboard/src/styles.css` 里还有 10–11px 的字号：第 288、367、476、484 行，`.pg-*` 系列和 `.md-code-lang`；
  - 侧栏分组标题 `shell/SidebarNav.tsx:30` 用的是 `text-[11px]`。
- **正文字号写死：** `text-[13px]` 在 `ui/*` 和各页面里写死了 44 处。建议在 `@theme` 里加一个 `--text-body`（带行高）统一替换。
- **死代码：**
  - `state/latency.ts:67` 的 `useLatency` 没有调用方；
  - `state/upstreams.ts` 里的 `probeResults` 没有消费方；
  - `CodexImportPanel` 的 `proxyFallbackList` 参数从未传入。
- **模型页 Markdown 回复里的 h1–h4 会进入页面大纲。** 建议降级成 h3 以下，或改成带 `role="heading"` 的元素。
- **`render-snapshot.test.tsx` 的 `mock.module` 会影响整个测试进程。** 它替换了 dompurify，如果以后在同一进程里加 sanitize 相关测试，sanitize 会被直接放行。建议改成注入 sanitizer。
- **决策面板非选中概率条的颜色**是用 `[&>div]` 覆盖 Meter 内部实现的。应该给 `ui/meter` 加一个 muted tone。
- **`ui/select` 不接受 id。** 用了它的字段，点击标签不会聚焦控件（上游页的 auth style、SDF 相关字段）。
- **拖拽排序不支持触屏，键盘排序没有读屏播报。**（上游页）
- **toast 的问题：**
  - 错误提示 4 秒后自动消失（`state/toast.tsx:32`），读屏用户可能来不及听，建议错误类不自动消失；
  - 仍在用固定色板，没改成语义 token。
- **代理页：** 密码和 PSK 是明文输入框，端口是文本框，首次加载前会闪一下空状态。
- **窄屏：** Keys 表格在手机宽度下需要横向滚动，可以考虑改成卡片列表。
- **服务端页面：**
  - 输入框尺寸（12px 16px / 14px）和 dashboard（7px 10px / 13px）不同，这是为了和全宽按钮对齐，有意保留；
  - 登录页副标题用了 `font-light` 加暗灰色，可以目测评估一下要不要加深。

### 4.3 测试稳定性

已修（不用再做）：

| 测试 | 原因 | 修法 |
|---|---|---|
| `usage-detail-capacity` | 写入时每次都同步磁盘，太慢 | fixture 设 `PRAGMA synchronous=OFF` + `journal_mode=MEMORY` |
| `catalog-coordinator.sqlite` | 同上 | 同上 |
| `dump-maintenance` | 同上 | 同上 |
| `reference-adapter` | 迁移文件和源码来自参考项目的不同版本 | 迁移文件改为和源码同一份快照 |

剩余：

- 在机器负载 40–70 时，偶尔还有其他测试超时，比如 `responses/session.sqlite`、`upstream-dto-races.sqlite`、`dispatch.test`、`setup-leases.d1`。
- 实测负载正常时，这些测试每个最多 0.2 秒；加上同样的 PRAGMA 也没有明显收益，所以没有改。
- 如果新机器上反复出现，先用 `bun test --timeout 120000 --reporter=junit --reporter-outfile=x.xml <file>` 量出每个测试的真实耗时，确认根因后再改。不要直接调大超时了事。
- 加 PRAGMA 前要确认：如果测试用两个连接访问同一个文件来测并发，这些设置不能改变它们之间的加锁行为。
- `messages.e2e` 的 503 用例跑约 7 秒，是在真实地等待重试退避，而且自带 20 秒超时，属于正常。

### 4.4 不做或需要所有者处理的

- GitHub Actions 账单锁：所有者明确说不要处理。

## 5. 验证方法

### 自动

```bash
cd vnext
bun run ci:local                                   # 全量门禁
bun test packages/gateway/tests/i18n-keys.test.ts  # 动了文案就必须跑
bun test apps/dashboard                            # dashboard 单测
```

### 浏览器走查（改了界面就必须做）

1. **启动本地网关：**

   ```bash
   bun run build:ui
   VNEXT_DB_PATH=<临时库> PORT=41499 NODE_ENV=production ACCOUNT_TYPE=individual bun apps/platform-bun/src/server.ts
   ```

2. **准备数据：**
   - 用临时 SQLite 文件。有本地 Docker 实例的话，可以用 `VACUUM INTO` 复制一份，绝不能直接用线上库。
   - 往 `user_sessions` 表插入一行会话（token 以 `ses_` 开头），通过一个设置 `session_token` cookie 的小跳转服务登录。
   - 管理员要求账号的邮箱在 `ADMIN_EMAILS` 里。
3. **检查范围：**
   - 宽度 1440、900、390；
   - 浅色和深色主题；
   - 中文和英文；
   - 键盘 Tab 的焦点；
   - 各页面 Lighthouse 无障碍要求 100。
4. **结束后清理：** 杀掉进程，删除临时目录。

## 6. 发布流程（仅在用户明确要求部署时）

部署需要原机器上的私有文件和凭据，包括 base compose（含密钥）、lab 的 SSH 密钥和 Cloudflare 登录。新机器上没有这些就不要尝试部署，先向所有者要访问方式。流程概要：

1. **建发布目录** `copilot-api-gateway-releases/<sha8>-<label>-<UTC时间>/`，里面放：
   - `git archive <sha> vnext` 解出的源码；
   - `compose.release.json` overlay，只设 image、build context 和 labels；
   - `release.json`，记录上一个版本，用于回滚；
   - `post-verify.ts`，从上一个 release 复制，并更新源码哈希和标记检查。
2. **本地 Docker 和 SSH lab：**
   1. 先在容器里用 `VACUUM INTO '/data/backups/pre-<release>.sqlite'` 备份；
   2. `up -d --no-build`；
   3. 约 90 秒内 `/health` 不返回 200 就自动回滚到上一个 overlay；
   4. 在容器里跑 `post-verify.ts`，检查源码哈希、数据未变、HTTP 状态和页面标记。
   - 源码送到 lab 时用 `git archive | ssh tar -x`。**不要在 macOS 上用 tar 打包**，会带进 `._*` 文件，导致迁移失败、容器反复重启。
   - lab 上的 git checkout 是旧的，**不要在那里 `git pull`**。
3. **Cloudflare：**
   1. 先确认 `bunx wrangler d1 migrations list copilot-db --remote` 显示没有待执行的迁移；
   2. 跑 `bun run build:ui`；
   3. 发布：`bunx wrangler deploy --tag <sha8> --message "vNext <sha8>: …"`；
   4. 冒烟检查：`/health` 和 `/dashboard` 返回 200，`/auth/google` 返回 302，`/auth/admin/users` 返回 403。
   - 刚部署完的几秒内，边缘节点可能还返回旧 HTML，重查一次再下结论。
   - 回滚用 `wrangler rollback <version-id>`。

## 7. 关键文件索引

| 用途 | 路径（相对 `vnext/`） |
|---|---|
| Dashboard 入口和外框 | `apps/dashboard/src/shell/` |
| UI 组件库 | `apps/dashboard/src/ui/` |
| 设计 token | `apps/dashboard/src/styles.css` |
| 各页面 | `apps/dashboard/src/tabs/*` |
| 状态和接口 | `apps/dashboard/src/state/*`、`apps/dashboard/src/api/*` |
| 文案（中英） | `packages/gateway/src/shared/edge/ui-pages/i18n.ts` |
| 服务端页面 | `packages/gateway/src/shared/edge/ui-pages/{layout,login,device,guide}.ts` |
| 认证错误页 | `packages/gateway/src/control-plane/auth/utils.ts`（`errorPage`） |
| 颜色一致性测试 | `packages/gateway/tests/ui-pages-token-parity.test.ts` |
| Dashboard 构建脚本 | `scripts/build-dashboard.ts` |
