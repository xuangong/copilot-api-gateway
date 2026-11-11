# Dashboard 重设计第二期·第四组：模型（含测试区）与定价 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把模型页（模型列表和四种测试区：对话/图像、决策、嵌入）和定价页迁移到 `src/ui` 组件和新设计规范上，功能一个不少；先把 1403 行的 `ChatPanel.tsx` 拆开，再换样式；最后清理 `styles.css` 里 `.pg-*` 的写死颜色和渐变，并删除旧的 `components/Select.tsx`。

**Architecture:**
1. 先补刻画测试，再对 ChatPanel 做纯重构拆分，渲染结果逐字节不变。
2. 再按"映射规则"逐个文件换控件和样式。测试区保持全高布局：左侧模型列表，右侧面板。手机上的抽屉、全屏模式、请求和流式逻辑都不变。
3. 旧版 Select 的最后几个使用者迁走后，删除 `components/Select.tsx`。全屏模式下的 Esc 判断要改为识别 Radix 的下拉。
4. 最后清理 CSS，并在浏览器里逐项验证。

**Tech Stack:** React 19、Tailwind 4.3、Radix（dialog、select、tooltip）、lucide-react、bun test（`renderToStaticMarkup`，无 DOM）。

**盘点报告（必读，带逐行引用）：** `/Volumes/Projects/copilot-api-gateway/.superpowers/sdd/dashboard-redesign/models-inventory.md`。下文的 M1–M47、P1–P5 就是报告第 2 节的功能清单，第 9 节是缺陷列表。

**参考：** 已迁移的页面 `apps/dashboard/src/tabs/keys/*`、`tabs/upstreams/*`。纯重构拆分的做法参考上一组的 `tabs/upstreams/upstream-form-state.ts` 和 `form/*`。

---

## 背景（实现者必读）

- 工作目录是 worktree `/Volumes/Projects/copilot-api-gateway/.worktrees/dashboard-models/vnext`，分支 `feat/vnext-dashboard-redesign-models`，基于 `352c6a3c`。**不要提交，不要 `git stash`**，由主控统一提交。不需要装新包。
- 设计 token 见 `apps/dashboard/src/styles.css` 的 `@theme inline`：
  - 背景和表面：`bg-background`、`bg-panel`、`bg-muted`
  - 文字：`text-fg`、`text-fg-muted`、`text-fg-subtle`
  - 边框：`border-border`、`border-input`、`border-control`
  - 品牌色：`bg-brand`、`text-brand-text`、`accent-brand`
  - 状态色：`text-success`、`text-warn`、`text-danger`、`text-info`；淡底上的文字用 `text-success-text`、`text-warn-text`、`text-danger-text`

  在 CSS 中可直接使用变量：`var(--brand)`、`var(--brand-text)`、`var(--success)`、`var(--warn)`、`var(--danger)`、`var(--border)`（先核对变量名是否真实存在）。焦点样式统一为 `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text`。
- **层级规则：** 全局 `input[type=text|password|email|number|url|date|search?]` 规则不在 layer 里，会压过工具类（具体包含哪些 type 以 `styles.css` 为准）。没写 `type` 的 input 不吃这条规则。要限制宽度就在外面包一层 div；等宽字体放在外层；不要在 input 上加 `!`。`textarea`、`select` 的全局规则在 `@layer components` 里，可以覆盖。
- `src/ui` 组件，先读源码再用：
  - 基础：`button`、`card`、`page-header`、`badge`、`notice`、`empty-state`、`meter`、`code-block`、`table`
  - 表单：`select`（Radix 实现；`""` 内部映射为哨兵；参数有 labelledBy、ariaLabel、describedBy；选项形状 `{value,label,badge?}` 与旧 Select 相同）、`segmented-control`
  - 浮层：`dialog`（打开时记住焦点、关闭后归还；点 toast 不会关闭）、`sheet`、`tooltip`、`dropdown-menu`
- 测试：`bun test apps/dashboard`；类型检查：`cd apps/dashboard && bun run typecheck`；lint：在 vnext 根目录 `bun run lint`（超时设长）；构建：`bun run build:ui`。新的字面量 `t("…")` 键必须在 `packages/gateway/src/shared/edge/ui-pages/i18n.ts` 的中英文两份字典里都存在（`bun test packages/gateway/tests/i18n-keys.test.ts`）。
- **文案不改。** 可见文字一律不变，包括写死的英文："Loading…"、"OpenAI/Anthropic/Gemini"、建议语、"Searched/Searching/Preparing search"、"System One"、"OpenAI Embeddings"、"TTFT"、`> {N}K` 等。**唯一例外：**
  1. 新增 aria-label 键（中英文都要加）。
  2. **写在代码里的 emoji 和字形**（🔍 💡 ⚡ 👋 🖼 🚫 ✎ ⬇ 🔎 ✂ ⚠ ✕ ▾ ▸ ▴ → 以及手写 SVG）换成 lucide 图标。图标后面的文字不变。前几组也是这么处理的，i18n 文案里本身带的字形保持不变。
- **测试契约：**
  - `tabs/models/mapped-models.test.tsx`：`ModelList` 的导出名和 9 个 props 不变；正则 `/class="pg-model-item is-selected"[^>]*>/`，所以选中项的 class 属性必须**正好**是 `pg-model-item is-selected`（样式可以写在 CSS 的这两个类上，不能往 class 属性里加别的类）；`playgroundModelOptions` 的返回形状不变。
  - `tabs/models/performance-details.test.tsx`：所列文字必须能被静态渲染出来（`<details>` 保留，不能用 Portal）。
- **持久化不变：** 所有 `playground.*` 的 localStorage 键和 IndexedDB `playground-images`。
- **流式和请求逻辑不变：** `send`、`retry` 的闭包行为照旧（盘点第 9 节第 17 条）。

## 映射规则（Task 2–9 通用）

| 旧写法 | 新写法 |
|---|---|
| 无 h1 | 模型页：`<h1 className="sr-only">{t("dash.models")}</h1>`（测试区是全高布局，不放可见页头）；定价页：`<PageHeader title={t("dash.pricing")}>` |
| `glass-card`、`animate-in` | `<Card>` |
| `btn-primary` / `btn-ghost` / `.pg-mini-btn` / 顶栏小按钮 | `<Button variant="primary"/"secondary"/"ghost" size="sm">`，文字不变 |
| 只有 title、没有名称的图标按钮 | `Button size="icon-sm"` 加 lucide 图标，aria-label 复用原来 title 用的键 |
| 切换按钮（System、Web Search、Raw 等） | 加 `aria-pressed` 或 `aria-expanded` |
| 多选一的按钮组（协议、决策格式、问题类型） | `<SegmentedControl>`，ariaLabel 用已有键或新增 aria 键 |
| `components/Select` | `ui/select`，用 labelledBy 或 ariaLabel |
| 只靠 placeholder 或 `div.pg-label` 做标签的字段 | `<label htmlFor>` 或 aria-labelledby，id 用 `useId` |
| 错误条（⚠ …） | `<Notice tone="danger">`，自带 role=alert；⚠ 换成图标或删除 |
| 种类、映射等徽章（`.pg-kind`、Mapped） | `<Badge>` |
| `text-[10px]`、`text-[11px]` | `text-xs` |
| `text-themed*`、`bg-surface-*`、`border-white/N`、`accent-*`、`text-black` | 语义 token |
| 只在悬停时出现的按钮（Copy、Retract、图片上的按钮） | 增加 `focus-visible` 和 `:focus-within` 时显示；触屏（`@media (hover:none)`）时常显 |
| 手写的遮罩层（手机抽屉、图片放大） | 抽屉用 `ui/sheet`（若从左侧滑出不合适，就用 Radix Dialog 自定义从顶部滑出，二选一）；放大用 `ui/dialog` 或 Radix Dialog 原语 |
| `.pg-*` CSS 中写死的 `#8b5cf6`、`#06b6d4`、`rgba(139,92,246,…)`、紫青渐变 | `var(--brand)`、`var(--brand-text)`，`color-mix(in oklab, var(--brand) N%, transparent)`；渐变全部去掉 |

## 本组新增的验证项（与 M1–M47、P1–P5 一起走查）

- **N1.** 页面有 h1（模型页为 sr-only，定价页可见）。Markdown 渲染出来的标题不影响页面大纲：`.md-body` 里的 h1–h4 改为渲染成 `<p role="heading" aria-level>`，或者保持现状，留到后续处理，二选一，在报告里说明。
- **N2.** 所有图标按钮都有可访问名称。切换按钮暴露状态；字段都有标签。
- **N3.** 附件按钮能用键盘触发（M35）。
- **N4.** 全屏模式下，打开 Radix 下拉时按 Esc 只关闭下拉，不退出全屏；放大图片时按 Esc 只关闭放大，不退出全屏（修复盘点第 9 节第 13 条）。
- **N5.** ImageParamsBar 在流式输出时真正禁用，键盘也操作不了。
- **N6.** 错误条用 role=alert 播报。
- **N7.** Copy、Retract、图片按钮在键盘聚焦时可见。
- **N8.** `components/Select.tsx` 已删除，没有任何引用。
- **N9.** `styles.css` 的 `.pg-*` 中没有写死的紫色和青色，也没有渐变；死规则已删除；`.pg-chart-tip*`（图表用）保留。

---

### Task 1: 刻画测试与 ChatPanel 拆分（纯重构）

**Files:**
- Create: `apps/dashboard/src/tabs/models/chat/` 下的 `chat-state.ts`（+test）、`chat-send.ts`、`useComposer.ts`、`ChatTopbar.tsx`、`ChatThread.tsx`、`ChatEmpty.tsx`、`ChatComposer.tsx`、`ImageZoom.tsx`。具体划分可以按实际代码调整，但要说明理由
- Create: `apps/dashboard/src/tabs/models/render-snapshot.test.tsx`（刻画测试，保留）
- Modify: `apps/dashboard/src/tabs/models/ChatPanel.tsx`

- [ ] **Step 1: 先写刻画测试并提交基线快照**

  `render-snapshot.test.tsx` 用 `renderToStaticMarkup` 渲染以下内容，并与 `__snapshots__` 或测试内的期望字符串比较（用 bun 的 `toMatchSnapshot()`）：
  - **ChatPanel：** 预先在 `localStorage` 里写好 `playground.messages`，内容要覆盖：用户和助手消息、带图片和占位的 parts、webSearches、超过 3 条的 citations、performance、usage。分别渲染以下状态：
    - mode 为 chat、image、undefined；
    - vision 为 yes、unknown、no、yes-but-rejected；
    - 空线程。
  - **ModelList：** 选中和未选中、映射模型、折叠分组。
  - **DecisionPanel、EmbeddingPanel：** 预置草稿。

  无 DOM 环境需要提供 `localStorage` 和 `window` 的桩，参考现有测试（如 `persistence.test.ts`、`mapped-models.test.tsx`）的做法。若某些 effect 在静态渲染下不会运行，就在快照覆盖范围里写明。**先在未改动的代码上生成快照**，确认测试通过。
- [ ] **Step 2: 拆分**

  按盘点报告第 10 节 T0 的建议拆分：
  - 纯函数放进 `chat-state.ts`，并补单元测试；
  - 发送管线放进 `chat-send.ts`；
  - 编辑器相关放进 `useComposer.ts`；
  - JSX 区块拆成组件；
  - ChatPanel 只保留状态、effect 和组装逻辑。

  JSX 原样搬，**一个 class 都不改**。`send` 和 `retry` 的闭包行为保持不变。
- [ ] **Step 3: 验证**

  Step 1 的快照必须原样通过，不许更新快照；`bun test apps/dashboard` 全部通过；类型检查和 lint 通过。报告里写明：拆分后各文件的行数，以及快照覆盖了哪些状态、没覆盖哪些。

---

### Task 2: 模型页外框与模型列表

**Files:** `apps/dashboard/src/tabs/models/ModelsTab.tsx`；可能还有 `i18n.ts`

- [ ] **Step 1:** 外框和顶栏：
  - 加 sr-only h1；
  - 无 key 时的界面改用 `EmptyState` 加 `Button variant="primary"`，文字不变；
  - key 加载错误用 `Notice tone="danger"`；
  - "Send with key:" 的 `<label>` 加 id，通过 `labelledBy` 关联到选择框。这一步**仍使用旧版 Select**，Task 3 再统一换掉，这里只把关联做好；如果旧 Select 不支持 `labelledBy`，就先保留现状，交给 Task 3；
  - System 切换加 `aria-expanded`，▴▾ 换成 `ChevronUp`、`ChevronDown`；
  - Web Search 切换加 `aria-pressed`，🔍 换成 lucide `Search`，文字不变；
  - 两个切换都用 `Button variant="ghost" size="sm"`，开启时用 `bg-muted text-fg`；
  - 系统提示的 textarea 加 aria-label，复用 `dash.playground.system` 或其 placeholder 键。
- [ ] **Step 2:** 手机抽屉：
  - "Models ▾" 按钮加 `aria-expanded`，▾ 换成图标；
  - 抽屉改为 Radix Dialog，从顶部滑出，带焦点锁定和 Esc 关闭。可以用 `ui/sheet`，也可以直接用 Radix 原语写在本文件里；
  - 标题用原来的文字；
  - 关闭按钮的 aria-label 优先复用已有的关闭键（如 `common.close` / `dash.closeBtn`）。
- [ ] **Step 3:** `ModelList`：
  - 搜索框加 aria-label，复用 placeholder 键，`type=search` 保留；
  - 分组头加 `aria-expanded`，▾▸ 换成 `ChevronDown`、`ChevronRight`；
  - 删除未定义的 `hover:bg-themed-soft`，改为 `hover:bg-muted`；
  - 种类徽章和 Mapped 徽章改用 `Badge`：种类用 neutral，Mapped 用 brand，title 不变；
  - `→ target` 行的 → 换成 `ArrowRight` 图标；
  - meta 行用 `text-xs`；
  - 选中项的 class 属性**仍然正好是** `pg-model-item is-selected`，样式在 CSS 里改（见 Task 9），或者通过子元素实现。
- [ ] **Step 4:** 修 `ModelsTab.tsx` 中 exhaustive-deps 的警告：这里本意是只运行一次，加上注释说明并 disable 掉。把变量名 `enabled` 改成如实的名字（行为不变）。
- [ ] **Step 5:** 运行测试（含 `mapped-models`）、类型检查、lint 和 i18n-keys，对照 M1–M15、N1、N2 自查。

---

### Task 3: 替换旧版 Select，修全屏 Esc，删除 components/Select

**Files:** `ModelsTab.tsx`、`ChatPanel.tsx`（或 Task 1 拆出的 `chat/ChatTopbar.tsx`）、`ImageParamsBar.tsx`、`model-options.ts`；删除 `components/Select.tsx`

- [ ] **Step 1:** 三处使用者都改用 `ui/select`：key 选择、全屏模型选择、ImageParamsBar 的 5–6 个参数。选项值和文字不变，必须带 labelledBy 或 ariaLabel。全屏模型选择的 ariaLabel 复用已有键（如 `dash.model`）。
- [ ] **Step 2:** `model-options.ts` 的 `SelectOption` 类型改为从 `ui/select` 导入，`playgroundModelOptions` 的返回形状不变（`mapped-models.test.tsx` 有覆盖）。
- [ ] **Step 3:** 修全屏 Esc：
  - 原来判断 `[data-select-open]`，现在改为在 keydown 处理里检查 `event.defaultPrevented`，或者检查 `document.querySelector('[data-radix-popper-content-wrapper]')` / `[role="listbox"]` 是否存在，以准确者为准；必要时让 `ui/select` 的 Content 在 Esc 时阻止事件继续传播；
  - 同时修掉"放大图片时一次 Esc 同时关闭放大和全屏"的问题（N4）；
  - 把判断逻辑提成纯函数，并加单元测试。
- [ ] **Step 4:** ImageParamsBar 流式输出时，把 `disabled` 真正传给每个 Select（N5），不再只用 `pointer-events-none`。
- [ ] **Step 5:** 删除 `components/Select.tsx`，再用 `grep -rn "components/Select" apps/dashboard/src` 确认没有引用（N8）。
- [ ] **Step 6:** 运行测试、类型检查和 lint，对照 M4、M18、M25 自查。

---

### Task 4: 对话顶栏与空状态

**Files:** `chat/ChatTopbar.tsx`、`chat/ChatEmpty.tsx`（以 Task 1 的实际文件为准）；可能还有 `i18n.ts`

- [ ] **Step 1:** 顶栏：
  - 协议切换改用 `SegmentedControl`，ariaLabel 用已有键（如 `dash.playground.protocol`）或新增 `dash.playground.protocolAria`（en "Protocol"，zh "协议"）；
  - 图像模式下原来是渲染后用 hidden 隐藏，改为不渲染（行为不变）。
- [ ] **Step 2:** vision 徽章改用 `Badge`：yes 用 success，unknown 用 neutral，no 或 rejected 用 danger，emoji 换成 lucide `Image`、`ImageOff`；文字和 title 不变。
- [ ] **Step 3:**
  - "Generating..." 加 `role=status`；
  - 上下文读数用 `tabular-nums`，颜色按 ok/warn/full 映射到 fg-muted/warn-text/danger-text；
  - Compact、Stop、Clear 用 `Button ghost sm`；
  - 全屏按钮改用 lucide 的 `Maximize2` 和 `Minimize2`，aria-label 复用 title 的键。
- [ ] **Step 4:** 空状态：
  - 去掉渐变标题，改为 `text-lg font-semibold text-fg`；
  - 三个建议改成卡片按钮，emoji 换成 lucide 的 `Lightbulb`、`Zap`、`Hand`，英文文字不变；
  - 点击后填入的内容不变。
- [ ] **Step 5:** 运行测试、类型检查和 lint；Task 1 的快照会变化，在确认变化符合预期后**有意**更新快照，并在报告里说明。对照 M16、M19–M26、N2 自查。

---

### Task 5: 对话线程

**Files:** `chat/ChatThread.tsx`（含消息行、来源列表）、`PerformanceDetails.tsx`；可能还有 `i18n.ts`

- [ ] **Step 1:** 气泡和头像：
  - 用户气泡用 `color-mix` 的品牌色淡底，助手气泡用 `bg-panel`；
  - 头像的家族配色保留，属于数据可视化；
  - Retract 改用 `ui/tooltip` 和 `Button ghost icon-sm`，aria-label 不变；在 `:focus-within` 和键盘聚焦时可见（N7）。
- [ ] **Step 2:** 图片：
  - ✎ 换成 `Pencil`，⬇ 换成 `Download`，都放在带 aria-label 的按钮里（复用 title 的键）；聚焦时可见；
  - 缩略图点击放大，改成用 `<button>` 包住图片，图片的 alt 用已有文案键，或保持空 alt 并给按钮加 aria-label；
  - 占位的 🖼 换成 `ImageOff` 图标。
- [ ] **Step 3:**
  - 搜索进度芯片：🔎 换成 `Search` 图标，写死的英文不变；
  - 来源列表改用 `Badge` 或链接样式，展开按钮的 ▴▾ 换成图标，`aria-expanded` 保留；
  - Copy 按钮聚焦时可见，"Copied" 状态不变；
  - 用量页脚用 `tabular-nums`；
  - `PerformanceDetails` 只改样式，测试中依赖的文字不变；
  - 压缩提示：✂ 换成 `Scissors` 图标，并加 `role=status`；
  - 错误条用 `Notice tone="danger"`，⚠ 删除，Retry 用 `Button secondary sm`（删除 `btn-ghost` 和 `!`）。
- [ ] **Step 4:** 运行测试（含 `performance-details`）、类型检查和 lint，有意更新快照，对照 M27–M33、N2、N6、N7 自查。

---

### Task 6: 输入区与图片放大

**Files:** `chat/ChatComposer.tsx`、`chat/ImageZoom.tsx`、`useComposer.ts`（只在必要时改）；可能还有 `i18n.ts`

- [ ] **Step 1:** 输入区：
  - contenteditable 加 aria-label，复用 placeholder 的文案键；
  - 外框改为 `rounded-xl border border-input bg-background`，`focus-within` 时品牌色描边；
  - 附件改为真正的 `<Button ghost icon-sm>` 加 `Paperclip`，点击时调用隐藏 file input 的 `click()`（N3），title 和 warn 着色逻辑不变，aria-label 复用 title 的键；
  - 发送和停止改用 `Button primary icon` 加 `ArrowUp`、`Square`，去掉渐变，aria-label 不变；
  - Enter、Shift+Enter、输入法组字、粘贴、拖放、双击放大，**逻辑一行不动**。
- [ ] **Step 2:** 图片放大：
  - 改用 Radix Dialog（`ui/dialog` 的样式不合适时，直接用原语），全屏黑底；
  - 标题用 sr-only，文案优先复用已有键，没有就新增 `dash.playground.zoomTitleAria`（en "Image preview"，zh "图片预览"）；
  - ⬇ 和 ✕ 换成带 aria-label 的按钮，✕ 显式调用 close；
  - 点图片或背景关闭，Esc 关闭；
  - 在全屏模式下按 Esc 只关闭放大（与 Task 3 的修复配合，N4）。
- [ ] **Step 3:** 运行测试、类型检查和 lint，有意更新快照，对照 M34–M38、N3、N4 自查。

---

### Task 7: 决策面板与示例条

**Files:** `DecisionPanel.tsx`、`PlaygroundExamples.tsx`；可能还有 `i18n.ts`

- [ ] **Step 1:** 格式切换和问题类型切换都改用 `SegmentedControl`。ariaLabel 复用已有键，或新增 `dash.playground.decisionFormatAria`（en "Request format"，zh "请求格式"）和 `dash.playground.decisionTypeAria`（en "Question {n} type"，zh "问题 {n} 类型"）。Native 标记改用 `Badge`。
- [ ] **Step 2:** 字段：
  - 所有输入框用 `useId` 关联标签，可见标签复用现有的 `pg-label` 文字；只有 placeholder 的字段加 aria-label，复用 placeholder 键；
  - 删除 `w-auto!`、`w-40!`、`mb-0!`、`mx-0!`，宽度靠外层 div 控制；
  - 问题卡片用 `rounded-lg border border-border bg-panel`，无效时 `border-danger`；
  - ✕ 换成 `X` 图标按钮，aria-label 复用 title 的键；
  - "Add option"、"Add level"、"+ 类型"用 `Button secondary sm`；
  - 警告用 `Notice tone="warn"`，⚠ 删除。
- [ ] **Step 3:**
  - Send 用 primary，Stop 用 secondary；
  - 结果中的概率条改用 `Meter`，或者用 token 色自绘：选中项 brand，其余 `bg-fg-subtle/40`，去掉渐变；
  - Raw 切换加 `aria-pressed`，`<pre>` 用 `font-mono text-xs bg-muted border border-border rounded-md`；
  - 错误用 `Notice tone="danger"`。
- [ ] **Step 4:** `PlaygroundExamples`：
  - 示例按钮选中时加 `aria-pressed`，配色改用 token；
  - 💡 换成 `Lightbulb` 图标；
  - Undo 用 `Button ghost sm`。
- [ ] **Step 5:** 运行测试（含 `decision`）、类型检查、lint 和 i18n-keys，有意更新快照，对照 M39–M44 自查。

---

### Task 8: 嵌入面板与定价页

**Files:** `EmbeddingPanel.tsx`、`tabs/pricing/PricingTab.tsx`；可能还有 `i18n.ts`

- [ ] **Step 1:** `EmbeddingPanel`：
  - 字段关联标签；计数超限时用 `text-danger`，删除 `!`；
  - Send、Stop、Raw 同 Task 7 的处理；
  - 错误用 `Notice`；
  - 相似度矩阵保留自定义实现，着色改为 `color-mix(in oklab, var(--brand) X%, transparent)`，nearest 描边用 `var(--brand-text)`；
  - 向量表改用 `ui/table`，数值列加 `numeric`。
- [ ] **Step 2:** `PricingTab`：
  - 加 `PageHeader title={t("dash.pricing")}`；
  - 每个 provider 一张 `Card`，provider 名称用 `SectionHeading`（h2），文字不变；
  - verifiedOn 和 Source 链接放在标题行右侧；
  - 表格用 `ui/table`：`Th` 加 scope，价格列加 `numeric`，模型名用 `Th row`；多档价格时 `rowSpan` 为档数，或保持空单元格并加 sr-only 的模型名，以不改可见文字为准；
  - 错误用 `Notice tone="danger"`；
  - 删除 `border-white/5`。
- [ ] **Step 3:** 运行测试、类型检查和 lint，有意更新快照，对照 M45–M47、P1–P5 自查。

---

### Task 9: CSS 清理

**Files:** `apps/dashboard/src/styles.css`

- [ ] 删除盘点报告第 5 节列出的死规则，以及 Task 2–8 已经替换掉、不再被引用的 `.pg-*` 规则。每删一条，先用 `grep -rn "<类名>" apps/dashboard/src` 确认没有引用。
- [ ] 剩下的 `.pg-*` 和 `.md-body` 中写死的颜色改用 token：`#8b5cf6`、`#06b6d4`、`rgba(139,92,246,…)`、`rgba(248,113,113,…)`、`#f87171`、`#f59e0b`，以及紫青渐变（全部删除）。`.md-body` 代码高亮的 hljs 调色板可以保留，属于语法着色；代码块背景改用 `var(--muted)` 之类的 token。修掉未定义的 `--surface-2` 和 `--border` 回退值。
- [ ] `.tip` 只被 Retract 使用；Retract 改用 `ui/tooltip` 后删除 `.tip`。
- [ ] `.pg-model-item.is-selected` 改用 token 着色。
- [ ] `.code-block-btn:hover` 的 `#8b5cf6` 改为 `var(--brand-text)`。这个类在其他页面也有使用，先确认它是否还有引用。
- [ ] **保留** `.pg-chart-tip*`。
- [ ] 运行全部测试（含快照）、类型检查和构建，对照 N9 自查。

---

### Task 10: 浏览器验证与全量检查（主控执行）

- [ ] 残留扫描：`tabs/models`、`tabs/pricing` 中应当没有 `glass-card|btn-|text-\[1[01]px\]|bg-surface-|accent-|border-white/|text-black|[a-z]!(\s|"|$)`，`components/Select` 也应当没有引用。
- [ ] 本地用临时数据库起网关，用管理员登录，浅色和深色主题各走一遍：
  - 列表：搜索、分组折叠、映射模型；
  - 对话：用真实上游发一条，看流式输出、Stop、Copy、Retract、Compact、Clear；
  - Web Search 开关；
  - 协议切换；
  - 全屏模式，以及打开下拉时按 Esc；
  - 图像模式的参数和发送（如果本地有图像模型）；
  - 粘贴图片和图片放大；
  - 附件按钮的键盘操作；
  - 决策面板：示例、格式切换、发送；
  - 嵌入面板：示例和矩阵；
  - 定价页；
  - 手机宽度下的抽屉。
- [ ] Lighthouse 无障碍评分：模型页（有对话记录时）和定价页都要达到 100。
- [ ] 全量检查 `bun run ci:local`，已知失败不计。
- [ ] 把遗留问题追加到 `.superpowers/sdd/dashboard-redesign/phase2-followups.md`。
