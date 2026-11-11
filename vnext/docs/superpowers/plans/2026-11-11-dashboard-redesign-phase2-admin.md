# Dashboard 重设计第二期·第五组：用户、代理、中继、设置、Agent Remote、账户菜单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把剩下的页面和全局部件迁移到 `src/ui`，功能一个不少：用户、代理、中继、设置、Agent Remote、账户菜单和 toast。然后删掉旧的 `components/Modal`、旧的共享样式类和固定的 v3 色板，第二期到此结束。

**Architecture:** 按"映射规则"逐个文件替换控件和样式类。结构、字段、文案和接口调用都不变。两个旧 Modal 改用 `ui/dialog`。最后一个任务清理 CSS 和死代码，并修改构建脚本里的样式检查。

**Tech Stack:** React 19、Tailwind 4.3、Radix、lucide-react、bun test。

**盘点报告（必读，带逐行引用）：** `/Volumes/Projects/copilot-api-gateway/.superpowers/sdd/dashboard-redesign/admin-inventory.md`，下文简称"盘点"。功能编号 U、X、R、S、A、M、T 见盘点第 2 节；缺陷见第 9 节；CSS 删除清单见第 10 节。

**参考：** 已迁移的页面 `tabs/keys/*`、`tabs/upstreams/*`（其中 `form/Field.tsx` 的 Field 写法负责标签关联、提示和错误）、`tabs/pricing/PricingTab.tsx`、`tabs/models/*`。

---

## 背景（实现者必读）

- 工作目录：worktree `/Volumes/Projects/copilot-api-gateway/.worktrees/dashboard-admin/vnext`，分支 `feat/vnext-dashboard-redesign-admin`，基于 `3a869604`。**不要提交，不要 `git stash`**。
- **设计 token：**
  - 背景和面板：`bg-background`、`bg-panel`、`bg-muted`
  - 文字：`text-fg`、`text-fg-muted`、`text-fg-subtle`
  - 边框：`border-border`、`border-input`、`border-control`
  - 品牌色：`bg-brand`、`text-brand-text`、`accent-brand`
  - 状态色：`text-success`、`text-warn`、`text-danger`；淡底上的文字用 `-text` 版本

  焦点样式统一为 `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text`。
- **输入框的全局样式：** 全局 `input[type=…]` 规则写在 layer 外，优先级高于工具类，所以：
  - 没写 `type` 的 input 不会套用它；
  - 要限制宽度，就在外面包一层 div；
  - 不要用 `!`。
- **`ui` 组件：**
  - 基础：button、card、page-header、badge、notice（tone 可选；role 可以覆盖）、empty-state、meter、table
  - 表单：select（labelledBy、ariaLabel、describedBy）、segmented-control（支持 disabled，label 可以传 ReactNode）
  - 浮层：
    - dialog：参数有 title、description、footer、onCloseAutoFocus。打开时记住焦点，关闭后归还；点击 toast 不会关闭它。
    - tooltip：需要外层有 `TooltipProvider`。
    - dropdown-menu
- **验证命令：**
  - 测试：`bun test apps/dashboard`
  - 类型检查：`cd apps/dashboard && bun run typecheck`
  - lint：在 vnext 根目录运行 `bun run lint`，超时时间设长一些
  - 构建：`bun run build:ui`
  - i18n：新增的字面量 `t("…")` 键（**必须用双引号**）要在 `packages/gateway/src/shared/edge/ui-pages/i18n.ts` 的中英文里都有，用 `bun test packages/gateway/tests/i18n-keys.test.ts` 检查。
- **文案不改。** 可见文字一律不变。具体包括：
  - 写死的英文："Agent Remote"、"Admin"、confirm 提示、"Deleted …"、`timeAgo`、"Unknown tab"、各个 placeholder；
  - i18n 文案里自带的字形，例如 "+ New node…"。

  **例外：**
  1. 代码里的 emoji、字形和手写 SVG 可以换成 lucide 图标。
  2. 可以新增只用于 aria 的键。
- **保留原生 `confirm()`。**
- **测试契约：**
  - `AgentRemoteTab.test.tsx`：
    - 导出的 `HostCard` 和 `ShareRow` 必须能在没有任何 Provider 的情况下静态渲染。所以它们内部不能用 `Tooltip`，也不能调用 `useToast`。
    - 这些文字要保持连续出现：`"3 / 3"`、`"3 / 5"`、`"Manage sharing"`、`"Offline"`、`"Owner"`、`"Codex"`、`"Revoked"`、`"Grant again"`、`"Existing sessions remain available"`、`href="/agent-remote?host=host_1"`。
    - 文本节点 `>Revoke<` 不能出现在已撤销的行里。
  - `AgentRemoteEntry.test.tsx` 和 `shell/shell.test.tsx`：后者会检查 `styles.css` 中 `[data-theme="light"] {` 下面紧跟一条 `/* … */` 注释和 `color-scheme: light;`，以及 dark 主题的对应写法。这几行不能动。
- `state/toast.tsx` 的 `data-toast-host` 属性和 `z-[60]` 必须保留，`ui/dialog` 依赖它们。

## 映射规则

| 旧写法 | 新写法 |
|---|---|
| 页面里没有 h1 | `<PageHeader title=… description=… actions=…>`；原来卡片里重复的标题删掉 |
| `glass-card`、`animate-in` | `<Card>` |
| 卡片标题（h3 或大写的 span） | `<SectionHeading>`，即 h2 |
| `btn-primary`、`btn-ghost`、未定义的 `btn-secondary`、带 `!` 的按钮 | `<Button variant=… size="sm">` |
| 只有字形或 SVG、没有名称的图标按钮 | `Button size="icon-sm"` 加 lucide 图标，再加 aria-label（复用已有的键） |
| 自定义徽章、计数胶囊 | `<Badge tone=…>` |
| 旧的 `components/Modal` | `ui/dialog` 的 `Dialog`，标题和 footer 不变 |
| 原生 `<select>` | `ui/select` |
| 没有 `name` 的单选组 | `<SegmentedControl>` |
| 只有 placeholder 的输入框、没有 `htmlFor` 的 label | 用 `useId` 生成 id 关联；错误用 `aria-invalid` 和 `aria-describedby` 关联 |
| 红色错误文字 | `text-danger`，或 `<Notice tone="danger">`（带 `role=alert`） |
| 空状态 | `<EmptyState title=…>`，文字不变 |
| `text-[10px]`、`text-[11px]` | `text-xs` |
| `text-themed*`、`bg-surface-*`、`border-surface-*`、`border-white/N`、`accent-*`、固定色板颜色 | 对应的语义 token |

## 本组新增的验证项

- **G1.** 每个页面都有 h1，标题层级不跳级。
- **G2.** 所有控件都有可访问名称；切换类按钮带 `aria-expanded` 或 `aria-pressed`。
- **G3.** 账户菜单里的两个弹窗和分配 Key 弹窗都是真正的对话框：焦点锁在弹窗内，按 Esc 能关闭，关闭后焦点回到原处。
- **G4.** toast 能被读屏播报（`aria-live`）。错误 toast 的配色用 danger 语义色。
- **G5.** 设置页的"选择文件"和"取消"按钮显示正常（修复未定义的 `btn-secondary`）；Merge/Replace 可以用方向键切换。
- **G6.** 中继页的在线圆点有样式（修复未定义的 `status-pulse`）。
- **G7.** 删除 `components/Modal.tsx` 和 `PlaceholderTab.tsx`；删除盘点第 10 节列出的 CSS；`weighted-formula.ts` 去掉 `colorClass`；构建检查改为检查仍然存在的类；最后用 grep 检查，旧类和旧色板一个都不剩。

---

### Task 1: toast、App、PlaceholderTab、账户菜单

**Files:**
- `state/toast.tsx`
- `App.tsx`
- `components/PlaceholderTab.tsx`
- `components/UserMenu.tsx`
- `i18n.ts`（只在需要新增 aria 键时改）

- [ ] **ToastHost**
  - 配色：错误 toast 用 `border-danger/40 bg-background text-danger-text`，或其他达到 AA 对比度的 danger 组合；成功用 success；普通用 `bg-panel text-fg`。
  - 圆角改为 `rounded-md`，阴影保留。
  - 容器加 `role="status" aria-live="polite"`。错误 toast 自身可以用 `role="alert"`，但不要和容器的 status 重复播报。
  - 保留 `data-toast-host`、`z-[60]`、`pointer-events-auto`，点击关闭和 4 秒自动消失的行为不变。
- [ ] **App.tsx 和 PlaceholderTab**
  - App.tsx 中的加载和错误状态改用 token。
  - `TabBody` 的 default 分支改为 `<EmptyState title="Unknown tab" />`，然后删除 `PlaceholderTab.tsx`。如果还有别的地方用它，就改样式而不删除。
- [ ] **UserMenu**
  - 两个弹窗改用 `Dialog`：
    - 标题、描述、footer 按钮的文字和禁用条件都不变；
    - 打开时重置状态的逻辑不变；
    - 密码弹窗在确认框按回车时提交的行为不变。
  - 表单：
    - 三个密码框用 `<label htmlFor>` 关联；
    - 邮箱框的 aria-label 复用 placeholder 的键；
    - 错误用 `text-danger`，加 `role=alert`。
  - 列表：
    - Admin 标记改为 `Badge tone="brand"`；
    - 分享列表的每一行用 `border-border` 分隔；
    - Revoke 按钮的 aria-label 带上对象名称，可以新增 aria 键 `dash.revokeShareAria`（en "Revoke {name}"，zh "撤销 {name}"）。
  - 清理：去掉所有 `!`、`text-[10/11px]`、`accent-*`。
- [ ] **检查**：运行测试、类型检查、lint 和 i18n-keys，对照 M1–M7、T1–T5、G3、G4 自查。

### Task 2: 用户页（含邀请码、分配 Key 弹窗）

**Files:**
- `tabs/users/UsersTab.tsx`
- `UserRow.tsx`
- `InviteCodesPanel.tsx`
- `AssignKeysModal.tsx`
- `i18n.ts`（需要时）

- [ ] **页头**
  - 加 `PageHeader title={t("dash.users")}`；刷新按钮放进 actions，用 `RefreshCw` 图标，aria-label 为 `dash.refreshLabel`，加载时禁用。
  - 删除用户列表卡片里重复的 "Users" 标题，改为 `<Card aria-labelledby=<h1 的 id>>`。如果 PageHeader 不支持传 id，就给 Card 加 `aria-label={t("dash.usersListHeader")}`。
- [ ] **邀请码卡片**
  - 标题用 `SectionHeading`；
  - 名称输入框加 aria-label（复用 placeholder 的键）；
  - "Used" 改为 `Badge`；
  - 复制按钮的样式改用 token，复制后的状态加 `aria-live`；
  - 删除按钮用 `Button ghost sm text-danger`，aria-label 带名称（新增 aria 键 `dash.deleteInviteAria`，en "Delete invite {name}"，zh "删除邀请 {name}"）。
- [ ] **用户行**
  - Disabled 标记和 Copilot 配额都改为 `Badge`，配额出错时用 danger；配额的 title 保留；
  - 行内按钮（Assign keys、Enable/Disable、Delete）用 `Button ghost sm`，Delete 加 `text-danger`；
  - 删除未定义的 `scrollbar-thin`；横向滚动保留。
- [ ] **分配 Key 弹窗**
  - 改用 `Dialog`；
  - 每个 key 是一个 `role="checkbox" aria-checked` 的按钮，或带 `aria-pressed` 的按钮，选中时显示 lucide `Check`；
  - 底部计数用 `tabular-nums`；Done 用 primary；
  - 关闭时（按 Esc、点遮罩或点 Done）仍然重新加载用户列表。
- [ ] **检查**：运行测试、类型检查、lint 和 i18n-keys，对照 U1–U17、G1–G3 自查。

### Task 3: 代理页

**Files:**
- `tabs/proxies/ProxiesTab.tsx`
- `ProxyForm.tsx`
- `i18n.ts`（需要时）
- 可选：`tabs/upstreams/ProxyChainEditor.tsx:51` 的依赖修复（把 `toast` 加进依赖数组）

- [ ] **页头**：`PageHeader title={t("dash.proxies")} description={t("dash.proxiesHint")}`，actions 放 "+ New node…"，用 primary sm。
- [ ] **编辑面板**
  - 外层用 `rounded-lg border border-border bg-panel p-4`；打开时把焦点移到第一个字段。
  - 字段改用 Field 写法，可以直接复用 `tabs/upstreams/form/Field.tsx`，或在本目录写一个同样的版本：标签用 `htmlFor` 关联，错误用 `aria-invalid` 和 `aria-describedby`，错误文字用 `text-danger`。
  - 所有 input 补上 `type="text"`。
  - Kind 和 Method 改用 `ui/select`；Anchor 也用 `ui/select`，ariaLabel 用 `dash.proxyAnchorLabel`。
  - Save、Test、Close 的禁用条件和文字都不变。
  - 测试结果：成功时用 `Notice tone="success"`，失败时用 `Notice tone="danger"`。
- [ ] **列表**
  - 每一行用 `rounded-lg border border-border`；
  - 显示/隐藏凭据的切换按钮加 `aria-pressed`，退避次数的按钮加 `aria-expanded`；
  - Edit 用 `ghost sm`，Delete 用 `ghost sm text-danger`；
  - 退避详情：Reset 按钮的样式改用 token，`lastError` 用 `text-danger`；
  - 空状态改用 `EmptyState`。
- [ ] **检查**：运行测试（包括 `proxy-form-config`、`proxy-test-state`）、类型检查、lint 和 i18n-keys，对照 X1–X10、G1、G2 自查。

### Task 4: 中继页和设置页

**Files:**
- `tabs/clients/ClientsTab.tsx`
- `tabs/settings/SettingsTab.tsx`
- `i18n.ts`（需要时）

- [ ] **中继页**
  - 加 `PageHeader title={t("dash.relays")}`，actions 放刷新按钮（`RefreshCw`，加载时旋转，aria-label 不变）。
  - 卡片用 `Card` 加 `SectionHeading`（`dash.relayClientsLabel`）。
  - 每一行：
    - 图标换成 lucide 的 `Monitor` 和 `KeyRound`，加 `aria-hidden`；
    - 在线状态的圆点用 `bg-success`，在线时加 `animate-pulse`，离线用 `bg-fg-subtle`；删除未定义的 `status-pulse`；
    - Online/Offline 文字用 `text-success` 或 `text-fg-subtle`；
    - 行容器用 token 样式。
  - 空状态改用 `EmptyState`；图例文字改用 `text-xs`。
- [ ] **设置页**
  - 加 `PageHeader title={t("dash.settings")}`。
  - 两张卡片用 `SectionHeading`，原来的说明文字保留。
  - 导出按钮用 primary，图标用 lucide 的 `Download`，导出中显示 `Loader2` 并加 `animate-spin`。
  - "选择文件"和"取消"改为 `Button variant="secondary"`。
  - 预览区用 token 样式。
  - Merge/Replace 改用 `SegmentedControl`，Replace 的 label 用 `<span className="text-danger">`，ariaLabel 复用已有的键或新增 `dash.importModeAria`（en "Import mode"，zh "导入模式"）。
  - Confirm 按钮的文字和禁用条件不变。
- [ ] **检查**：运行测试、类型检查、lint 和 i18n-keys，对照 R1–R6、S1–S8、G5、G6 自查。

### Task 5: Agent Remote

**Files:**
- `tabs/agent-remote/AgentRemoteTab.tsx`
- 必要时：`components/AgentRemoteEntry.tsx`
- `i18n.ts`（需要时）

- [ ] **页头**：用 `PageHeader title={dash.remote.title 对应的文字}`，h1 的文字保持 "Agent Hosts"。description 用原来的 hint，actions 放 Refresh 和 "Open controller"。链接用 `Button asChild` 包 `<a>`。
- [ ] **主机卡片（HostCard）**
  - 外层 `Card`，主机名用 h2；
  - 在线状态和 provider 改为 `Badge`；
  - 共享额度用 `Meter`，tone 由 `meterTone` 决定；
  - "Manage sharing" 用 secondary sm，保留 `aria-expanded`。
- [ ] **分享区（HostShares、ShareRow）**
  - 输入框改用 token 样式，不用 `!`；
  - 错误用 `Notice tone="danger"`（自带 alert）；
  - 按钮按映射规则替换；
  - 不使用 `Tooltip` 和 `useToast`。
- [ ] **空状态和错误**：空状态改用 `EmptyState`，加载用 `role=status`。
- [ ] **两个同名链接**：页头和卡片上的 "Open controller" 都可以加 aria-label 区分。卡片上的新增 aria 键 `dash.remote.openHostAria`（en "Open controller for {name}"，zh "在控制台中打开 {name}"）。可见文字不变。
- [ ] **检查**：`AgentRemoteTab.test.tsx` 和 `AgentRemoteEntry.test.tsx` 必须原样通过。再运行测试、类型检查、lint 和 i18n-keys，对照 A1–A8 自查。

### Task 6: 清理（第二期收尾）

**Files:**
- `styles.css`
- `components/Modal.tsx`（删除）
- `components/weighted-formula.ts`
- `vnext/scripts/build-dashboard.ts`
- `state/timezone.ts`（修复 lint 警告）

- [ ] **删除死代码**
  - 用 `grep -rn "components/Modal" apps/dashboard/src` 确认没有引用后，删除 `Modal.tsx`。
  - 删掉 `weighted-formula.ts` 里没人用的 `colorClass`。
- [ ] **清理 `styles.css`**
  - 按盘点第 10 节的表格删除。**每删一项，先用 grep 确认** `apps/dashboard/src` 中没有引用；也要搜动态拼接的类名和 Tailwind 工具类形式，例如 `text-red-500`、`bg-surface-800`。
  - 保留盘点里"必须保留"的部分：
    - `--surface-900…600` 这几个原始变量（语义 token 和 `.pg-*` 在用）；
    - `.theme-toggle`；
    - `.pg-*`、`.md-body`、`.pg-chart-tip*`；
    - 全局输入框规则；
    - `shell.test` 依赖的那几行。
- [ ] **修改构建检查**：`build-dashboard.ts` 第 46 行原来检查 `.text-accent-violet`，改为检查仍然存在的类（例如 `.bg-brand` 加 `.text-fg-subtle`），并同步更新注释。
- [ ] **修复 `timezone.ts:151` 的 no-useless-assignment 警告**：只改写法，行为不变。
- [ ] **最终 grep**：在 `apps/dashboard/src` 中搜下面这些，应该一个都不剩（`.test.` 文件和注释除外）：
  ```
  glass-card|btn-(primary|ghost|secondary)|text-themed|border-themed|bg-surface-|border-surface-|accent-(violet|cyan|teal|amber|red)|(violet|sky|fuchsia|amber|slate|emerald|red|blue|purple|green|gray)-[0-9]{3}|animate-in|hover-lift|scrollbar-thin|status-pulse
  ```
- [ ] **全部检查**：`bun test apps/dashboard`、类型检查、lint（dashboard 不应再有警告）、`bun run build:ui`，以及 `bun test packages/gateway/tests/i18n-keys.test.ts`。

### Task 7: 浏览器验证与全量检查（主控执行）

- [ ] **管理员走查**：本地用临时数据库启动网关，以管理员身份走查，浅色和深色主题各一遍：
  - 用户页：邀请码的创建、复制和删除；分配 Key 弹窗；启用/禁用用户（在临时库上操作）；
  - 代理页：新建节点、校验、测试、编辑、退避详情；
  - 中继页；
  - 设置页：导出；导入只预览，不确认；
  - Agent Remote（如果本地已启用）；
  - 账户菜单：My Sharing 弹窗、改密码弹窗（只打开、校验，不真正提交）、Sign out 菜单项；
  - toast。
- [ ] **普通用户走查**：核对 Settings 菜单不可见；`#users` 和 `#proxies` 没有入口。
- [ ] **Lighthouse 无障碍评分**：上述每个页面都达到 100。
- [ ] **全量检查**：`bun run ci:local`，已知的失败不计。
- [ ] **记录遗留**：把遗留问题追加到 `phase2-followups.md`。
