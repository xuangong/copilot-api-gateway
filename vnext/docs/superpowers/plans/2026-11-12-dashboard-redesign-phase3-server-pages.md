# Dashboard 重设计第三期：服务端页面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录页（`/`）、设备授权页（`/device/login`）和接入指南页（`/guide`）改用 dashboard 新的配色和字体。页面结构、可见文字和行为都不变（spec 第三章"第三期"）。

**Architecture:** 继续用 CDN 版 Tailwind 3。主要改 `layout.ts`：

- 把 `<style>` 中的变量和自定义类、Tailwind config 以及字体链接换成 dashboard 的 token；
- 保留旧的类名和变量名，作为新 token 的别名，这样页面文件基本不用动；
- 页面文件里只改 class 字符串和行内样式值，不动 DOM。

**盘点（必读，带逐行引用）：** `/Volumes/Projects/copilot-api-gateway/.superpowers/sdd/dashboard-redesign/server-pages-inventory.md`。下文的"§N"指盘点报告的第 N 节。

**取值来源：** `apps/dashboard/src/styles.css` 中 `:root` 和 `[data-theme]` 下的 token。旧类名到新 token 的映射在第一期已经做过一遍，见 `git show adfd2925:vnext/apps/dashboard/src/styles.css`，可以照着改。

## 背景（实现者必读）

- 工作目录：worktree `/Volumes/Projects/copilot-api-gateway/.worktrees/server-pages/vnext`，分支 `feat/vnext-server-pages-tokens`，基于 `57f412c6`。**不要提交，不要 `git stash`。**
- 本期涉及的文件：`packages/gateway/src/shared/edge/ui-pages/layout.ts`、`login.ts`、`device.ts`、`guide.ts`。`Layout()` 只被这三个页面使用，dashboard 有自己的 `page.ts`，不受影响。
- **文案不改。** `i18n.ts` 里通过 `x-html` 渲染的字符串自带 class，比如 `text-accent-violet`、`bg-surface-700`、`text-themed`。这些字符串不能改，dashboard 也在用，只能靠 config 或 CSS 重新映射。
- **透明度陷阱：** Tailwind 3 把颜色写成 `var(--x)` 时会忽略透明度后缀（`/5`、`/10`、`/20`、`/60`）。所以 config 里的颜色要写成以下任一形式：
  - `'rgb(var(--brand-text-rgb) / <alpha-value>)'`，每个主题各定义一组 RGB 通道变量；
  - `'color-mix(in oklab, var(--brand-text) calc(<alpha-value> * 100%), transparent)'`。

  改完要在浏览器里确认淡底确实是半透明的。
- **验证：**
  - 没有测试会渲染这些页面，所以靠浏览器走查（见 Task 3）。
  - 必须通过：`bun test packages/gateway`（需要先有 build 产物，可以执行 `bun run build:ui` 和 `bun run build:setup`）；在 vnext 根目录跑 `bun run lint`；类型检查用 `cd packages/gateway && bunx tsc --noEmit -p .`，或者用仓库现有的 typecheck 脚本，以实际可用的为准。

## 视觉规则

| 旧 | 新 |
|---|---|
| Outfit / IBM Plex Mono | Geist / Geist Mono，字体 URL 与 `dashboard-app/page.ts` 相同；正文 14px，数字用 `tabular-nums` |
| 旧 surface、text 变量取值 | dashboard 两套主题的取值（§3 表格） |
| `.glass-card`（毛玻璃、16px 圆角、阴影） | 实色 `var(--surface-900)` 背景，`var(--border-color)` 边框，8px 圆角，无阴影 |
| `.glow-primary` / `.glow-border` / 噪点 `body::before` / `.aurora-border` | 去掉（类名保留为空实现，或映射到边框） |
| `.btn-primary`（紫青渐变） | `var(--brand)` 底，`var(--brand-foreground)` 字，hover 用 `var(--brand-hover)`，6px 圆角，`:focus-visible` 时 2px `var(--brand-text)` 描边；尺寸不变 |
| `accent.violet` / `cyan` / `teal` / `amber` / `red` | 分别映射为 brand-text / info / success / warn / danger；**作文字颜色时**，teal、amber、red 用 `*-text` 变体（`textColor` 单独配置） |
| 行内 `var(--accent-teal, #2dd4bf)` 按钮 | 在 `layout.ts` 中定义 `--accent-teal: var(--brand)`，单一强调色，`login.ts` 不用改 |
| 输入框焦点几乎看不见 | 与 dashboard 一致：边框用 `brand-text`，外加 `--ring` |
| 光晕元素、写死的 rgba 边框和底色 | 去掉光晕；rgba 改成 token 的 `color-mix` |
| 指南步骤圆圈：白字压在青、绿、琥珀、浅灰底上 | 统一为 brand 底白字 |
| `text-[10px]` / `text-[11px]` | `text-xs`（12px） |
| `.animate-in` | 位移 4px、0.2s，并加 `prefers-reduced-motion` 规则 |

---

### Task 1: layout.ts 的 token、组件类和字体

**Files:** `packages/gateway/src/shared/edge/ui-pages/layout.ts`

- [ ] **样式变量：** 在 `:root`/`[data-theme="light"]` 和 `[data-theme="dark"]` 中，按 dashboard 的取值设置：
  - surface、text、border、input、control 系列；
  - brand、brand-hover、brand-text、brand-foreground、ring；
  - info、success、warn、danger 及对应的 `*-text`；
  - `color-scheme`；
  - Tailwind config 需要的 RGB 通道变量。

  旧变量保留为别名：`--glass-bg`、`--glass-border`、`--glow-border`、`--glow-color: transparent`、`--card-shadow: none`、`--accent-teal: var(--brand)`。tooltip、grid 等其他旧变量如果仍被引用，也一并保留。
- [ ] **Tailwind config：**
  - `fontFamily` 改为 Geist 和 Geist Mono；
  - `surface.*` 和 `accent.*` 按上面的透明度写法定义；
  - 文字颜色单独映射：teal、amber、red 用 `*-text`，cyan 用 info；
  - `borderColor.DEFAULT` 设为 `var(--border-color)`。

  确认 `bg-accent-violet/10`、`text-accent-violet/60`、`border-accent-red/20` 等写法都能生成半透明色。
- [ ] **组件类：** 按"视觉规则"重写自定义类：
  - `.glass-card`、`.glow-*`、`.btn-primary`、`.theme-toggle`（参照 dashboard `styles.css` 中的写法）；
  - `.text-themed*`、`.border-themed`、`.animate-in`；
  - 输入框和焦点样式；
  - 删除噪点和 aurora。

  `input.font-mono` 需要单独设成 Geist Mono，让设备码保持等宽。删除这几个页面都没用到的规则时要谨慎，先 grep 三个页面文件和 `i18n.ts`。
- [ ] **字体链接：**
  - 换成 dashboard 用的 Google Fonts URL；
  - 页面里有 `font-light`，所以加载 300 字重，或者接受回退到 400，二选一并在报告中说明；
  - 把 `layout.ts` 里写死的 `'Outfit'` 和 `'IBM Plex Mono'` 全部换掉。
- [ ] **可选：** 删掉这几个页面没用到的 Chart.js 和 Prism `<script>`/`<link>`。删之前先 grep 确认没被用到；如有疑问就保留。
- [ ] **检查：** 运行 lint 和 gateway 测试。

### Task 2: 页面上的少量修正

**Files:** `login.ts`、`device.ts`、`guide.ts`（只改 class 字符串和行内样式值）

- [ ] **登录页和设备页：** 去掉光晕元素上的 `bg-accent-violet/5 … blur-[120px]`，元素本身可以保留。
- [ ] **`login.ts:88`：** `border-themed-border` 改为 `border-themed`。原类名未定义，深色主题下会出现一条亮线。
- [ ] **行内 rgba 改为 token：**
  - `guide.ts:126`、`:133`、`:163`、`:244`；
  - `device.ts:118`。

  写成 `color-mix(in oklab, var(--success) 8%, transparent)` 这类形式，或者使用 Task 1 定义的 wash/edge 变量。
- [ ] **指南页：**
  - 步骤圆圈统一用 brand 底白字；
  - 徽章改用 warn 淡底配 `warn-text` 文字；
  - `text-[10px]` 和 `text-[11px]` 改为 `text-xs`。
- [ ] **无障碍（只加属性，不改可见文字）：**
  - 语言和主题两个按钮加 `aria-label`，复用已有文案；没有合适的就新增 aria 键，中英文都要加；
  - 文字按钮和复制按钮加 `focus-visible` 描边；
  - 错误框加 `role="alert"`；
  - 如果 label 和 input 能通过 `for`/`id` 关联，而且不改 DOM 结构，就加上。
- [ ] **检查：** 运行 lint 和 gateway 测试。

### Task 3: 浏览器验证（主控执行）

- [ ] 用一份临时数据库启动 `apps/platform-bun`。在 1440、900、390 三种宽度下，浅色、深色、中文、英文各看一遍：
  - **`/`（未登录）：**
    - 主视图正常；
    - 用错误的账号密码登录，出现错误框；
    - 填一个无效的邀请码，出现错误；
    - 插入一个有效邀请码后，欢迎信息和注册表单正常显示。
  - **`/` 带会话：** 跳转到 `/dashboard`。
  - **`/device/login`：**
    - 未登录时的视图；
    - 已登录时，先用 `POST /auth/device/code` 拿到 code，打开 `?code=…`，确认预填的等宽 code 和授权按钮显示正常，再点授权，确认成功视图；
    - 无效 code 出现错误。
  - **`/guide`：** 6 个步骤、FAQ、`x-html` 链接、行内 `<code>`、复制按钮（Copy → OK）、吸顶的页头和客户端卡片都正常。
  - **所有页面都要检查：**
    - 用 Tab 能看到焦点；
    - 主题和 `/dashboard` 同步；
    - 切换语言后页面会刷新；
    - Network 面板能看到 Geist 的 woff2 已加载；
    - 半透明淡底是真的半透明。
- [ ] 每个页面的 Lighthouse 无障碍评分都要达到 100。
- [ ] 跑 `bun run ci:local`（已知会失败的用例不计）。
- [ ] 遗留问题记入 followups（例如 `errorPage()` 还没改样式）。
