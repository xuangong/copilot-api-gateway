# Dashboard 重设计第二期·第三组：上游（Upstreams）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上游页（`tabs/upstreams` 全部组件）迁移到 `src/ui` 组件和新设计规范上，功能一个不少；先把 1014 行的表单拆成几个文件，再换样式。

**Architecture:**
1. 先做纯重构：把 `UpstreamFormModal.tsx` 的纯逻辑和各个字段区拆到同目录的文件里，不改任何界面和行为。
2. 再按"映射规则"逐个文件替换控件和样式类。页面结构、字段、文案、接口调用、拖拽排序逻辑都不变。内联展开的表单和面板仍是内联的，不改成弹窗。
3. 唯一的弹窗 DeviceFlowModal 改用 `ui/dialog`。
4. 最后按功能清单在浏览器里逐项验证。

**Tech Stack:** React 19、Tailwind 4.3、Radix（dialog、select、dropdown-menu、tooltip）、lucide-react、bun test（`renderToStaticMarkup`，无 DOM）。

**盘点报告（必读，带逐行引用）：** `/Volumes/Projects/copilot-api-gateway/.superpowers/sdd/dashboard-redesign/upstreams-inventory.md`。下文的 F1–F46 编号就是报告第 2 节的功能清单。

**参考：** 第二组（API Keys）已经迁移完，风格对齐 `apps/dashboard/src/tabs/keys/*`，尤其是 `KeysTab.tsx`、`UpstreamAccessPanel.tsx`、`ModelMappingsPanel.tsx`、`WebSearchPanel.tsx`、`JustCreatedKeyModal.tsx`。

---

## 背景（实现者必读）

- 工作目录是 worktree `/Volumes/Projects/copilot-api-gateway/.worktrees/dashboard-upstreams/vnext`，分支 `feat/vnext-dashboard-redesign-upstreams`，基于 `3e25de76`。**不要提交，不要 `git stash`**，由主控统一提交。不需要装新包。
- 设计 token 见 `apps/dashboard/src/styles.css` 的 `@theme inline`：
  - 背景和表面：`bg-background`、`bg-panel`、`bg-muted`
  - 文字：`text-fg`、`text-fg-muted`、`text-fg-subtle`
  - 边框：`border-border`、`border-input`、`border-control`
  - 品牌色：`bg-brand`、`text-brand-text`；复选框和单选框用 `accent-brand`
  - 状态色：`text-success`、`text-warn`、`text-danger`、`text-info`；淡底上的文字用 `text-success-text`、`text-warn-text`、`text-danger-text`

  焦点样式统一为 `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text`。
- **层级规则：** `styles.css` 里的全局 `input[type=text|password|email|number|url|date]` 规则不在 layer 里，会压过所有工具类，强制 `width:100%`，并覆盖 padding、边框、圆角、字号和字体。另外两点：
  - **没写 `type` 的 `<input>` 不吃这条规则，会显示成浏览器默认样式。** 所以每个文本输入框都要补上 `type="text"`，URL 用 `type="url"` 也行，但要确认不会因此触发浏览器校验，改变提交行为（表单若是 `<form>` 提交，用 `type="text"` 最稳）。
  - 限制宽度时在外面包一个定宽的 div，等宽字体放在外层 div 上；不要在 input 上加 `!`。`textarea`、`select` 的全局规则在 `@layer components` 里，工具类可以覆盖。
- `src/ui` 现有组件，先读源码再用：
  - 基础：`button`（variant 有 primary/secondary/ghost/danger，size 有 sm/md/icon/icon-sm）、`card`（`Card`、`SectionHeading`）、`page-header`、`badge`、`notice`（tone 有 info/success/warn/danger，role 可覆盖）、`empty-state`、`meter`、`code-block`、`table`
  - 选择类：`select`（Radix，`""` 内部映射为哨兵值）、`multi-select`、`segmented-control`（radiogroup）
  - 浮层类：`dialog`（居中 Radix 弹窗，参数 title/description/footer/onCloseAutoFocus）、`dropdown-menu`、`tooltip`、`sheet`
- 测试：`bun test apps/dashboard`；类型检查：`cd apps/dashboard && bun run typecheck`；lint：在 vnext 根目录 `bun run lint`（耗时长，超时设大一些）；构建：`bun run build:ui`。新增的字面量 `t("…")` 键必须在 `packages/gateway/src/shared/edge/ui-pages/i18n.ts` 的中英文两份字典里都存在（`bun test packages/gateway/tests/i18n-keys.test.ts` 检查）。
- **文案不改。** 可见文字一律不变，包括 i18n 文案里自带的字形（"+ Add Copilot"、"↻ Models"、"+ Add hop" 等）和写死的英文（"copy"、"(unknown)"、confirm 文本、toast 文本）。**唯一例外**是新的 aria-label 键，中英文都要加。
- **删除确认保持原生 `confirm()`。**
- **模块路径不能动：** gateway 的测试直接导入了 `apps/dashboard/src/tabs/upstreams/duplicate-draft.ts` 和 `model-text.ts`，这两个文件的路径和导出名都不能改。
- **保留这些属性：** `CodexQuotaPanel` 上的 `data-testid`、`data-upstream-id`、`data-active-limit`、`data-freshness`，研究脚本靠它们定位元素。
- `components/Modal.tsx` 和 `components/Select.tsx` 不要改，Users 页和 Models 页还在用。

## 映射规则（Task 2–9 通用）

| 旧写法 | 新写法 |
|---|---|
| 页面顶部 `glass-card` 里的 h3 页面标题 | `<PageHeader title=… description=… actions=…>`（h1）；原来的 h3 删掉 |
| `glass-card`、`animate-in` | `<Card>`；动画类删除 |
| 分组标题按钮 | 外层 h2 里放 `<button aria-expanded>`，文字不变；或者 `SectionHeading` 包按钮 |
| 行名称 `<span>` | h3（样式不变：`text-[13px] font-medium text-fg`） |
| 表单标题 `<div>`、表单内的 h4、h5 | 表单标题 h3，表单分节 h4，flag 分组标题 h5 或带 `role="group"` 的 `aria-labelledby`；不跳级 |
| `text-[10px]`、`text-[11px]` | `text-xs` |
| `text-themed` / `text-themed-secondary` / `text-themed-dim` | `text-fg` / `text-fg-muted` / `text-fg-subtle` |
| `bg-surface-*`、`border-surface-*`、行内 `style={{background:"var(--surface-…)"}}` | `bg-panel` / `bg-muted` / `border-border` |
| `btn-primary` / `btn-ghost` / 无样式的红字按钮 | `<Button variant="primary" size="sm">` / `<Button variant="ghost" size="sm">`（或 secondary）/ `<Button variant="ghost" size="sm" className="text-danger">`；按钮文字原样保留 |
| 代码里的字形 `▾ ▶ ▼ ↻ ⠿ ↑ ↓ × ✕ ← …` | lucide 图标（`ChevronDown`、`ChevronRight`、`RefreshCw`、`GripVertical`、`ChevronUp`、`X`、`ArrowLeft`、`Loader2`），放进 Button；保留原有 title 和 aria-label；没有可访问名称的补 aria-label（优先复用已有键）。**i18n 文案里的字形不动** |
| 忙碌时显示的 "…" | 保持显示 "…"，或换成 `Loader2` 旋转图标并保留原来的 title；按钮的可访问名称不能变成空 |
| `accent-violet` 文字 | `text-brand-text` |
| `accent-red`、`text-red-*`、`border-red-500` | `text-danger`；淡底上用 `text-danger-text`；边框用 `border-danger` |
| `text-emerald-400` | `text-success` |
| `accent-amber` | `text-warn-text` |
| 红、黄、绿底的提示框 | `<Notice tone=…>`；原来有 `role=alert` 或 `role=status` 的保留 |
| 胶囊、徽章 | `<Badge tone=…>` |
| KindChip 的固定色板（violet/sky/fuchsia/amber/slate） | 语义 Badge（brand/neutral/success/warn），文字不变；头像角标用 `bg-muted` 加 `ring-border`，不用白字配亮色 |
| 原生复选框 | 保留 `<input type="checkbox">`，加 `accent-brand` |
| 原生单选组 | 有 `name` 的保留并加 `accent-brand`；flag 覆盖用 `SegmentedControl`（见 Task 6） |
| 原生 `<select>`（单选） | `ui/select`，用 `labelledBy` 关联可见标签 |
| 原生 `<select multiple>` | 保留，加样式和标签关联（见 Task 6） |
| `<details>` 和 `<summary>` | 保留；▶ 换成 lucide `ChevronRight`，展开时旋转 90°；summary 加焦点样式 |
| `!` 工具类 | 换成组件后删除 |
| 未定义的类：`input-field`、`scrollbar-none` | 删除；输入框补 `type`，横向滚动条隐藏用 `styles.css` 已有的 `scrollbar-hide` |
| 数据驱动的行内样式（宽度百分比） | 保留 |

## 功能清单

逐项验证盘点报告第 2 节的 **F1–F46**（Task 10 执行）。另外，本组改动带来的变化：

- **G1.** 页面有 h1（PageHeader）；标题层级为 h1 → h2（每个 owner 分组）→ h3（行名、表单和面板标题）→ h4（表单分节），不跳级。
- **G2.** 预设菜单改为 `DropdownMenu`：支持方向键，Esc 关闭，焦点回到触发按钮；菜单项文字、顺序和点击效果不变。
- **G3.** 分组折叠按钮，以及 Edit、Proxy、"+ Loki"、"+ New node…" 这几个展开按钮都带 `aria-expanded`。
- **G4.** 特性开关的三选一改成 SegmentedControl：每个 flag 是一个带名称的 radiogroup，方向键可以切换，三个选项的文字不变。
- **G5.** 补全可访问名称：
  - Disabled models 的多选、额外 id 输入框、"×" 移除按钮；
  - 代理链里每一跳的选择框和 ↑ ↓ ✕ 按钮，以及新节点的三个输入框；
  - 设备授权里的 host 和 token 两个输入框（标签用 `htmlFor` 关联）；
  - 刷新按钮 ↻；
  - 启用复选框：可见文字仍是 On 或 Off，用 `aria-describedby` 指向行名，读屏能知道是哪个上游。
- **G6.** 启用复选框在该行忙碌时禁用，防止连点发出两次 PATCH。
- **G7.** DeviceFlowModal 用 `ui/dialog`：`role=dialog`、标题关联、焦点锁定、Esc 关闭、关闭后焦点回到打开它的按钮。
- **G8.** 所有文本输入框都有样式，不再出现浏览器默认外观。
- **G9.** 额外 id 输入框按回车等同于点 Add（F31 的小缺口）。

---

### Task 1: 拆分 UpstreamFormModal（纯重构，不改界面）

**Files:**
- Create: `apps/dashboard/src/tabs/upstreams/upstream-form-state.ts`、`upstream-form-state.test.ts`
- Create: `apps/dashboard/src/tabs/upstreams/form/CustomFields.tsx`、`AzureFields.tsx`、`SdfFields.tsx`、`ServedEndpointsField.tsx`、`DisabledModelsSection.tsx`、`FeatureFlagsSection.tsx`
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx`

- [ ] **Step 1: 把纯逻辑移到 `upstream-form-state.ts`**

  搬过去的内容：`FormState`、`EMPTY`、`SDF_*` 选项表、端点和路径常量、`buildInitial`、`sdfTuning`、`parseAzureDeployments`、`groupFlags`，以及 submit 里构造请求体的纯函数部分（如果能干净地抽出来）。名字和签名保持不变，`UpstreamFormModal.tsx` 改为从这里导入。
- [ ] **Step 2: 为搬出来的纯函数补测试（先写，确认通过）**

  `upstream-form-state.test.ts` 覆盖：
  - `buildInitial`：create、edit、duplicate、preset 四种来源；
  - `sdfTuning`：空字段填默认值；
  - `parseAzureDeployments`：合法、重复、非法；
  - `groupFlags`：vendor、behavior、transform 三组的分组。

  这些是对现有行为的刻画测试，断言值以当前实现的实际输出为准，不要为了测试改实现。
- [ ] **Step 3: 把字段区拆成组件**

  每个组件通过 props 接收 `form`、`update`、`editing`（以及该区需要的回调和状态）。JSX 原样搬过去，**一个 class 都不改**，样式留给 Task 5 和 Task 6：
  - `CustomFields`：base URL、key、auth style、模型列表、models endpoint、路径覆盖；
  - `AzureFields`：含部署校验错误的显示，校验逻辑留在父组件或 state 模块；
  - `SdfFields`；
  - `ServedEndpointsField`；
  - `DisabledModelsSection`：`extraIdInput` 状态移进来；
  - `FeatureFlagsSection`。

  copilot 信息框和 codex 导入仍内联在主文件里。主文件保留 state、catalog 加载（含 request gate 的 ref）、submit、头部和底部。
- [ ] **Step 4: 验证行为不变**

  运行 `bun test apps/dashboard`、`bun test packages/gateway/tests/control-plane-upstream-duplicate-metadata.test.ts packages/gateway/tests/model-editor-roundtrip.test.ts`、类型检查和 lint。

  然后对比渲染结果：用 `renderToStaticMarkup` 分别渲染拆分前后的 `UpstreamFormModal`，覆盖 custom、azure、sdf、copilot-edit、codex-create 五种情况，确认 HTML 完全一致。拆分前的版本用 `git show HEAD:…` 取到临时文件。对比脚本用完删掉，在报告里写明结果。若组件依赖 hook 或 store 导致无法静态渲染，就逐段比对 JSX 文本，并说明原因。

---

### Task 2: 页面外框、预设菜单和分组

**Files:**
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx`

- [ ] **Step 1:** 页头：
  - 用 `<PageHeader>`，title 用原来 h3 的文案键，description 用原来的说明；
  - 按钮条放进 `actions`，顺序和文字不变。"+ Add Copilot" 用 primary sm，其余用 secondary sm；
  - ↻ 改为 `Button variant="ghost" size="icon-sm"` 加 `RefreshCw`，aria-label 优先复用现有的"刷新"类键（搜索 i18n 中的 `refresh`），没有合适的就新增 `dash.upstreamsReloadAria`（en "Reload upstreams"，zh "重新加载上游"）。title 仍为 "Refresh"；
  - 按钮条窄屏时可以换行（`flex-wrap`），不要依赖未定义的 `scrollbar-none`。
- [ ] **Step 2:** 预设菜单改为 `DropdownMenu`：
  - 触发按钮就是原来的 "+ Add Custom ▾"，文字不变，▾ 换成 `ChevronDown` 图标；
  - 菜单标题（原来的小字标题）用 `DropdownMenuLabel`；
  - 各个预设和 "Blank custom upstream…" 用 `DropdownMenuItem`，onSelect 调原来的 `openCreate`；
  - 删除手写的 role=menu 和相关状态。
- [ ] **Step 3:**
  - "+ Loki" 加 `aria-expanded`；
  - 外层 `glass-card` 改为 `Card`；
  - 加载中和空状态的文字不变，空状态用 `EmptyState`（title 为原文案）；
  - `Expand` 包装保留，或者直接条件渲染，二选一，前提是行为相同。
- [ ] **Step 4:** 分组头：
  - 用 h2 包一个 `<button type="button" aria-expanded>`，里面依次是 `ChevronRight` 或 `ChevronDown`、标签、`Badge`（You 用 brand，Read-only 用 neutral）和数量（`text-xs text-fg-subtle tabular-nums`）；
  - 点击效果不变。
- [ ] **Step 5:** 拖拽相关的 `onDragStart`、`onDragOver`、`onDrop`、Esc 取消、`canDropOn`、`moveUpstream`、ReorderController 调用，**代码一行不动**。拖动中的视觉反馈只换 token 颜色。
- [ ] **Step 6:** 运行测试、类型检查和 lint，对照 F1–F4、G1–G3 自查。

---

### Task 3: 上游行和 KindChip

**Files:**
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx`、`apps/dashboard/src/tabs/upstreams/KindChip.tsx`

- [ ] **Step 1:** 行容器：
  - `rounded-lg border border-border bg-panel`；token 过期时 `border-danger`；
  - 锁定行原来整行 `opacity-60`，改为只让操作区变淡或禁用，文字保持正常对比度。锁定时哪些按钮禁用，条件不变；
  - 行名用 h3。
- [ ] **Step 2:** 按钮条：
  - ⠿ 改为 `GripVertical`，放在 `Button ghost icon-sm` 里。**`draggable`、拖拽事件、ArrowUp/ArrowDown 的 onKeyDown、aria-label 和 title 都不变**；
  - ↑↓ 改为 `ChevronUp`、`ChevronDown`，放在 icon-sm 按钮里，aria-label 用原来 title 的键；
  - Edit/Close、Duplicate、↻ Models、Refresh credential、Re-auth、Proxy/Close 用 `ghost sm`，文字不变。Edit 和 Proxy 加 `aria-expanded`（需要父组件传入展开状态，若已有对应 prop 就直接用）；
  - Delete/Sign out 用 `ghost sm text-danger`；
  - "…" 忙碌态见映射规则。
- [ ] **Step 3:** 启用开关：
  - 保留原生复选框，加 `role="switch"`、`accent-brand`；可见文字仍是 On/Off；
  - `aria-describedby` 指向行名 h3 的 id，id 用 `useId` 生成；
  - **该行忙碌时 `disabled`**（G6）。
- [ ] **Step 4:** 信息行：
  - 过期胶囊用 `Badge tone="danger"`，原来的提示改用 `ui/tooltip`，或保留 title，二选一，提示文字不变；
  - codex 健康行和 loki 状态行用 `text-xs text-fg-muted`，健康状态的颜色用 success/warn/danger 文字 token；
  - 模型芯片样式参照 `tabs/keys/ConfigurationPanel.tsx` 里"其他可用模型"的芯片，复制行为、Shift 点击和 title 都不变；"Show all / Collapse" 用 `ghost sm`。
- [ ] **Step 5:** `KindChip.tsx`：
  - 去掉固定色板，provider 徽章改为 `Badge`：copilot 和 codex 用 brand，其余用 neutral，或按现有分组映射到语义 tone，只要白字配亮色的组合全部消失即可；
  - 头像角标改用 `ring-border`；
  - 字母兜底头像用 `bg-muted text-fg-muted`；
  - `FULL_LABEL` 文字不变。
- [ ] **Step 6:** 运行测试、类型检查和 lint，对照 F5–F22、G5、G6 自查。

---

### Task 4: Codex 配额面板

**Files:**
- Modify: `apps/dashboard/src/tabs/upstreams/CodexQuotaPanel.tsx`

- [ ] 改动内容：
  - 原来的 h4 在行 h3 之下，层级正确，保留为 h4，样式用 `text-xs font-medium text-fg-muted`；
  - 百分比旁加 `Meter`，tone 用 `meterTone(pct)`，数字文字不变；
  - 出错时用 `Notice tone="danger"`（保持 `role=alert`）；
  - 重新读取按钮用 `ghost sm`；
  - **所有 `data-*` 属性原样保留。**
- [ ] 运行测试和类型检查，对照 F13 自查。

---

### Task 5: 表单样式 A：外框和 Custom、Azure、SDF、端点字段

**Files:**
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx`、`form/CustomFields.tsx`、`form/AzureFields.tsx`、`form/SdfFields.tsx`、`form/ServedEndpointsField.tsx`
- 可能 Modify: `i18n.ts`（新增 aria 键）

- [ ] **Step 1:** 表单外框：
  - 删除行内背景样式，改为 `rounded-lg border border-border bg-panel p-4`；
  - 标题由 div 改为 h3，文字不变；
  - × 改为 `Button ghost icon-sm` 加 `X`，aria-label 不变；
  - 预设说明和复制提示用 `Notice tone="info"`；
  - 底部 Cancel 用 ghost sm，Save/Create 用 primary sm，禁用条件不变。
- [ ] **Step 2:** `Field` 包装：
  - 标签用 `text-xs font-medium text-fg-muted`，提示用 `text-xs text-fg-subtle`；
  - **提示不要再放在 `<label>` 里面**，改为 `aria-describedby` 关联，修掉 auth style 选择框的可访问名称把提示也读进去的问题；
  - 所有没有 `type` 的 input 补上 `type="text"`（G8）；
  - 密码框保持 `type="password"`。
- [ ] **Step 3:** 选择框：
  - auth style、SDF 的 experience、traffic、service tier 四个原生 `<select>` 改为 `ui/select`，用 `labelledBy` 关联标签，选项值和文字不变；
  - 先确认这些选项里没有 `""` 值；有的话 `ui/select` 会自动处理。
- [ ] **Step 4:** Azure 部署的错误提示：`text-xs text-danger`，输入框加 `aria-invalid` 和 `aria-describedby`，删除 `border-red-500`（全局 input 规则会覆盖边框色，靠 `aria-invalid` 加文字提示即可）。
- [ ] **Step 5:**
  - 端点复选框：`accent-brand`，用 `grid` 排列，端点 id 用 `font-mono text-xs`，分组标题为 h4；
  - SDF 的 passport 复选框：`accent-brand`；
  - 路径覆盖的 `<details>`：summary 用 `ChevronRight` 并带焦点样式。
- [ ] **Step 6:** copilot 编辑时的只读信息框：`rounded-md border border-border bg-muted px-3 py-2`，文字不变。
- [ ] **Step 7:** 运行测试、类型检查和 lint，对照 F23–F28、F30、F33、F34、G8 自查。

---

### Task 6: 表单样式 B：禁用模型和特性开关

**Files:**
- Modify: `apps/dashboard/src/tabs/upstreams/form/DisabledModelsSection.tsx`、`form/FeatureFlagsSection.tsx`
- 可能 Modify: `i18n.ts`

- [ ] **Step 1:** 禁用模型：
  - 分节标题为 h4，加 id；
  - Refresh 用 `ghost sm`，忙碌时的文字不变；
  - 加载中、出错、无缓存三种状态分别用 `text-fg-subtle`、`Notice tone="danger"`、`text-fg-subtle`；
  - `<select multiple>` 保留原生控件（多选语义和保留过期 id 的逻辑都不变），加 `aria-labelledby` 指向 h4，样式为 `w-full rounded-md border border-input bg-background text-[13px] font-mono`；
  - 额外 id 输入框：补 `type="text"`，aria-label 优先复用 placeholder 的键；**按回车等同于点 Add**（G9），并 `preventDefault`，防止提交外层表单；
  - Add 用 secondary sm；
  - 已禁用的 id 用 `Badge` 显示，内嵌 `Button ghost` 的 `X`，aria-label 为 `` `${t(<已有的 remove 或 delete 键>)} ${id}` ``，没有合适的键就新增 `dash.removeDisabledModelAria`（en "Remove {id}"，zh "移除 {id}"）。
- [ ] **Step 2:** 特性开关（G4）：
  - 每组的标题为 h5，或者用 `role="group"` 加 `aria-labelledby`；
  - 每个 flag 一行：左侧是名称和说明，右侧是 `SegmentedControl size="sm"`；
  - 三个选项的值对应原来三个 radio 的状态（inherit、on、off），**文字和原来的 label 完全一致**（包括 "Inherit (On)" / "Inherit (Off)" 这样带默认值的写法），`ariaLabel` 用 flag 的名称文案；
  - onChange 调原来的更新函数；
  - 原来 On 用绿色、Off 用红色，由 SegmentedControl 的选中样式代替，不再按状态上色。
- [ ] **Step 3:** 运行测试、类型检查、lint 和 i18n-keys，对照 F31、F32、G4、G5、G9 自查。

---

### Task 7: Codex 导入与 Loki 配对

**Files:**
- Modify: `apps/dashboard/src/tabs/upstreams/CodexImportPanel.tsx`、`apps/dashboard/src/tabs/upstreams/LokiPairingPanel.tsx`

- [ ] **Step 1:** `CodexImportPanel`：
  - 标题为 h4；
  - 文档文本框用 `font-mono text-xs`；文件选择框保留原生控件，样式为 `text-[13px] text-fg-muted`；
  - Preview 用 secondary sm，Import/Reimport 用 primary sm；
  - 候选项保留原生单选（`accent-brand`），每项用 `rounded-md border border-border` 包起来；不可导入的项变淡，问题列表用 `text-danger text-xs`；
  - 错误提示用 `Notice tone="danger"`。
- [ ] **Step 2:** `LokiPairingPanel`：
  - 外框为 `rounded-lg border border-border bg-panel p-4`；
  - 标题 h4 改为 h3，原来的 h5 改为 h4（标题在行 h3 之下时层级为 h3 → h4；作为新建面板挂在 Card 下时同样适用）；
  - 删除 `input-field`，输入框补 `type="text"`，`type="url"` 也可以；
  - 按钮按映射规则替换；
  - HTTPS 警告用 `Notice tone="warn"`，错误用 `Notice tone="danger"`；
  - 配对文档**保留只读 textarea**（因为有聚焦即全选的行为），样式为 `font-mono text-xs bg-muted`；Download 和 Copy 用 secondary sm，Copied 状态不变；
  - `aria-describedby` 保留。
- [ ] **Step 3:** 运行测试（含 `loki-pairing`、`codex-import-draft`）、类型检查和 lint，对照 F29、F35–F37 自查。

---

### Task 8: Copilot 设备授权对话框

**Files:**
- Modify: `apps/dashboard/src/tabs/upstreams/DeviceFlowModal.tsx`（必要时连带改 `UpstreamsTab.tsx` 里挂载它的地方）
- 可能 Modify: `i18n.ts`

- [ ] **Step 1:** 从 `components/Modal` 换成 `ui/dialog` 的 `Dialog`：
  - 标题文字沿用原来 Modal 的 title；
  - 关闭（Esc、点遮罩、Close 按钮）走原来的 onClose。**轮询的清理逻辑必须照旧在关闭时执行**，先核对原来 onClose 和 effect cleanup 是怎么停止轮询的；
  - 宽度可用 `className="max-w-md"` 之类调整。
- [ ] **Step 2:** HostPicker：
  - 两个 host 选项改为全宽的选择卡片按钮：`rounded-lg border border-border hover:bg-muted`，带焦点样式，文字不变；
  - egress proxy 的 `<details>` 保留，summary 用 `ChevronRight`；里面的 ProxyChainEditor 由 Task 9 处理。
- [ ] **Step 3:** DeviceFlowStep：
  - 验证码用大号 `font-mono tabular-nums`，放在 `bg-muted` 框里；
  - 验证链接用 `text-brand-text underline`；
  - 状态和错误用 Notice；
  - ← Back 用 `Button ghost sm`，配 `ArrowLeft` 图标；**可见文字仍包含原来的"← Back"文案**（如果文案里自带 ←，就不再加图标）。
- [ ] **Step 4:** PasteTokenStep：
  - host 和 token 两个输入框用 `useId` 生成 id，`<label htmlFor>` 关联；
  - host 补 `type="text"`；token 的 textarea 用 `font-mono`；
  - 帮助的 `<details>` 保留；命令用 `ui/code-block`，复制按钮的 copyLabel 用原来的 "copy" 文字（复制后的状态若原来没有，就保持不变）；
  - Connect 按钮的禁用条件和等待中的文字不变。
- [ ] **Step 5:** 运行测试、类型检查和 lint，对照 F38–F40、G7 自查。

---

### Task 9: 代理链编辑器

**Files:**
- Modify: `apps/dashboard/src/tabs/upstreams/ProxyChainEditor.tsx`、`apps/dashboard/src/tabs/upstreams/ProxyChainModal.tsx`
- 可能 Modify: `i18n.ts`

- [ ] **Step 1:** `ProxyChainEditor`：
  - 标题由 div 改为 h4，加 id；
  - 每一跳一行：编号（`tabular-nums text-fg-subtle`）、`ui/select`、↑↓✕；
  - select 的 ariaLabel 用新增键 `dash.proxyHopAria`（en "Hop {n}"，zh "第 {n} 跳"），选项值和文字不变，包括 "unknown node" 选项；
  - ↑↓✕ 改为 `ChevronUp`、`ChevronDown`、`X`，放在 `Button ghost icon-sm` 里。aria-label 优先复用已有的上移、下移、删除键（例如 UpstreamRow 用的 moveUp、moveDown），需要带跳号时新增 `dash.proxyHopMoveUpAria`、`dash.proxyHopMoveDownAria`、`dash.proxyHopRemoveAria`（en "Move hop {n} up" / "Move hop {n} down" / "Remove hop {n}"，zh "上移第 {n} 跳" / "下移第 {n} 跳" / "移除第 {n} 跳"）；
  - "+ Add hop" 和 "+ New node…" 用 secondary sm，后者加 `aria-expanded`；
  - 新节点的三个输入框补 `type`，加 aria-label（复用 placeholder 键；没有键的用新增键 `dash.proxyNodeNameAria`、`dash.proxyNodeUrlAria`、`dash.proxyNodeTimeoutAria`，en "Node name" / "Node URL" / "Timeout"，zh "节点名称" / "节点地址" / "超时"）；
  - 删除所有 `!`。
- [ ] **Step 2:** `ProxyChainModal`：
  - 外框为 `rounded-lg border border-border bg-panel p-4`；
  - Save 用 primary sm（忙碌时的 "…" 按映射规则处理），Close 用 ghost sm。
- [ ] **Step 3:** 运行测试、类型检查、lint 和 i18n-keys，对照 F41–F43、G5 自查。

---

### Task 10: 浏览器验证与全量检查（主控执行）

- [ ] **Step 1:** 残留扫描，在 `tabs/upstreams` 中应无输出：

  ```bash
  cd apps/dashboard/src
  grep -rnE "glass-card|btn-(primary|ghost|secondary)|text-\[1[01]px\]|border-white/|bg-surface-|border-surface-|var\(--surface|accent-(violet|teal|red|amber|cyan)|(violet|sky|fuchsia|amber|slate|emerald|red)-[0-9]{3}|animate-in|input-field|scrollbar-none|[a-z]!(\s|\"|$)" tabs/upstreams | grep -v "\.test\."
  ```
- [ ] **Step 2:** 用本地临时数据库启动网关（复制本地 Docker 的数据库，用管理员会话登录），逐项走查 F1–F46 和 G1–G9，浅色和深色主题各看一遍。重点检查：
  - 拖拽排序和键盘排序：键盘移动后焦点是否还在手柄上；
  - 预设菜单；
  - 四种表单：custom（选一个预设）、azure、sdf、编辑 copilot；
  - 复制上游；
  - 禁用模型和特性开关；
  - Loki 面板；
  - 设备授权对话框：只走到显示验证码为止，不完成授权，然后关闭，确认轮询已停止；
  - 代理链编辑；
  - 手机宽度（390px）。
- [ ] **Step 3:** 用普通用户登录，核对只读分组和 Proxy 按钮的可见性（F21、F44、F45）。
- [ ] **Step 4:** Lighthouse 无障碍评分，目标 100：分别展开编辑表单、打开设备授权对话框时各跑一次。
- [ ] **Step 5:** 全量检查 `bun run ci:local`。已知失败 `reference-adapter` 和容量测试超时不计。
- [ ] **Step 6:** 把评审和走查中发现、但不在本组范围内的问题追加到 `.superpowers/sdd/dashboard-redesign/phase2-followups.md`。
