# Dashboard 重设计第二期·第二组：API Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 API Keys 页（`tabs/keys` 全部面板和 `tabs/requests/RequestsPanel`）迁移到 `src/ui` 组件和新设计规范上，功能一个不少，并修掉盘点中发现的几处现有缺陷。

**Architecture:**
1. 先在 `src/ui/` 补齐这一组需要的组件：对话框、进度条、代码块，并给 Notice 加 success 色调和可覆盖的 role。
2. 再按"映射规则"逐个面板替换控件和样式类。页面结构、字段、文案、接口调用和面板顺序都不变。
3. 最后按功能清单在浏览器里逐项验证。

**Tech Stack:** React 19、Tailwind 4.3、Radix（dialog、select、tooltip）、lucide-react、bun test（`renderToStaticMarkup`，无 DOM）。

**Spec:** `docs/superpowers/specs/2026-11-11-dashboard-redesign-design.md`（第三章"第二期"）

---

## 背景（实现者必读）

- 工作目录是 worktree `/Volumes/Projects/copilot-api-gateway/.worktrees/dashboard-keys/vnext`，分支 `feat/vnext-dashboard-redesign-keys`，基于 `9d239ee6`（第一组）。**不要提交，不要 `git stash`**，由主控统一提交。
- 不需要装新包：`@radix-ui/react-dialog`、`@radix-ui/react-select`、`@radix-ui/react-tooltip`、`lucide-react` 都已装好。
- 设计 token 定义在 `apps/dashboard/src/styles.css` 的 `@theme inline`：
  - 背景和表面：`bg-background`、`bg-panel`、`bg-muted`
  - 文字：`text-fg`、`text-fg-muted`、`text-fg-subtle`
  - 边框：`border-border`、`border-input`（输入框边界）、`border-control`（按钮、芯片）
  - 品牌色：`bg-brand`、`text-brand-text`；复选框用 `accent-brand`
  - 状态色：`text-success`、`text-warn`、`text-danger`、`text-info`；淡底上的文字用 `text-warn-text`、`text-danger-text`

  焦点样式统一为 `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text`。
- **层级规则：** v4 中不在 layer 里的 CSS 会压过所有工具类。`styles.css` 里的全局 `input[type=text|password|email|number|url|date]` 规则不在 layer 里，会强制 `width:100%`，并覆盖 padding、边框、圆角和字号。原生输入框直接吃全局样式；要限制宽度时，**在外面包一个定宽的 div**，不要在 input 上加 `!`。`textarea`、`select` 的全局规则在 `@layer components` 里，工具类可以覆盖。
- 现有 `src/ui` 组件（用法看源码）：
  - `button`：variant 有 primary/secondary/ghost/danger，size 有 sm/md/icon/icon-sm
  - `tooltip`：`TooltipProvider`、`Tooltip`（content、side、disabled、open、onOpenChange）
  - `dropdown-menu`
  - `sheet`
  - `page-header`：输出 h1，参数 title、description、actions
  - `card`：`Card`，以及 `SectionHeading`（`as` 可选 h2 或 h3）
  - `segmented-control`：radiogroup，支持方向键
  - `select`：Radix 实现，`""` 映射为哨兵值 `"__all__"`，用 labelledBy 或 ariaLabel 命名，可带 badge
  - `multi-select`
  - `table`：`Table`（可选 label）、`Th`（numeric、row）、`TBody`、`Td`（numeric）
  - `badge`：tone 有 neutral/brand/success/warn/danger
  - `empty-state`
  - `notice`：tone 有 info/warn/danger；danger 自带 `role=alert`
- 测试：`bun test apps/dashboard`；类型检查：`cd apps/dashboard && bun run typecheck`；lint：在 vnext 根目录 `bun run lint`；构建：`bun run build:ui`。新增或改动的字面量 `t("…")` 键必须在 `packages/gateway/src/shared/edge/ui-pages/i18n.ts` 的中英文两份字典里都存在（`packages/gateway/tests/i18n-keys.test.ts` 会检查）。
- **文案不改。** 写死的英文（`timeAgo` 的 "just now"、删除确认、"searches / ok / failed"、"1d/7d/30d"、Setup 的平台名等）原样保留，留到 i18n 阶段统一处理。**唯一例外**是新的 aria-label 键，中英文都要加。
- **删除确认保持原生 `confirm()`。** 改成对话框需要新增可见文案，不在本组范围内。
- 不要改 `components/Select.tsx`、`components/Modal.tsx`、`components/weighted-formula.ts`：Models、Users、Upstreams 和 Usage 页还在用它们。`components/Combobox.tsx` 只有 ModelMappingsPanel 在用，可以直接改。

## 映射规则（Task 2–11 通用）

| 旧写法 | 新写法 |
|---|---|
| 页面顶部 `glass-card` 里的 h3 页面标题 `dash.apiKeys` | `<PageHeader title={t("dash.apiKeys")}>`（h1）；原来的 h3 删掉 |
| `glass-card` 容器（含 `animate-in`、`delay-*`、`glow-primary`） | `<Card>`；动画类删除 |
| 卡片标题：大写 `<span>` 或 h3 | `<SectionHeading>`（h2），文案键不变；原来 section 上的 `aria-labelledby` 继续指向它的 id |
| 卡片内的小标题（原来是 h4、h5） | `<SectionHeading as="h3">` 或 `text-[13px] font-medium text-fg` 的 h3；层级为 h1 → h2 → h3，不跳级 |
| 字段标签（`text-[10px]` / `text-[11px]`，常带 uppercase） | `text-xs font-medium text-fg-muted`，不再大写；能关联的 `<label>` 一律加 `htmlFor` |
| 其余 `text-[10px]`、`text-[11px]` | `text-xs` |
| 数字上的 `font-mono` | `tabular-nums`；key 片段、模型 id、哈希、密钥、代码仍用 `font-mono` |
| `text-themed` / `text-themed-secondary` / `text-themed-dim` | `text-fg` / `text-fg-muted` / `text-fg-subtle` |
| `border-themed`、`border-white/N`、`bg-white/N`（非输入框） | `border-border`；悬停底色 `hover:bg-muted` |
| `bg-surface-800` / `-700` / `-600`（表面、悬停、选中） | `bg-panel` / `bg-muted`；选中项用 `bg-muted` 加左侧或前置的品牌色标记 |
| `btn-primary` / `btn-ghost` / `btn-secondary` / Setup 里的本地按钮类 | `<Button variant="primary">` / `<Button variant="ghost" size="sm">` / `<Button variant="secondary" size="sm">`；按钮文字的文本节点保持原样 |
| 卡片头部的 Edit、Save、Cancel | Edit 用 `ghost sm`，Save 用 `primary sm`，Cancel 用 `ghost sm` |
| 手写 SVG 图标、字形 `▲ ▼ ↑ ↓ × ⠿ ↗ ▶` | lucide 图标（`Copy`、`Check`、`Trash2`、`Info`、`X`、`ChevronUp`、`ChevronDown`、`GripVertical`、`Link2`），放在 `<Button variant="ghost" size="icon-sm">` 里；保留原有的 title、aria-label 和禁用条件。没有 aria-label 的图标按钮，把原来 title 用的同一个 `t()` 键也作为 aria-label。文本里起连接作用的 `→`、`·`、`∞` 保留 |
| 原生 `title` 提示 | 图标按钮保留 title（也可改用 `ui/tooltip`）；数据类 title（完整时间、分享名单）保留 |
| `text-accent-red`、`text-red-400` | `text-danger`；淡底上用 `text-danger-text` |
| `text-accent-teal`、`text-green-400` | `text-success` |
| `text-accent-amber`、`text-amber-400` | 文字用 `text-warn-text`，图标或细边用 `text-warn` |
| `text-accent-violet` | `text-brand-text` |
| `bg-accent-*/N` 加同色文字的胶囊 | `<Badge tone=…>` |
| 红、黄、绿底的提示框（`role=alert` 或 `role=status`） | `<Notice tone="danger" / "warn" / "success">`；原来带 `role=status` 的，通过新的 `role` 参数保留 |
| `accent-accent-violet`（复选框） | `accent-brand` |
| 原生复选框、`role=switch` 的复选框 | **保留原生 `<input type="checkbox">`**（UpstreamAccess 的测试依赖它），只换颜色和间距 |
| `components/Select` | `ui/select` 的 `Select`；可见标签加 `id`，再通过 `labelledBy` 关联 |
| 原生 `<select>`（Setup） | `ui/select` |
| 手写的分段按钮（Config 的客户端标签、格式切换，WS 的 1d/7d/30d） | `<SegmentedControl>`，ariaLabel 用新增的 aria 键 |
| 手写遮罩层（JustCreated、WS 借用选择器） | `ui/dialog` 的 `Dialog` |
| `code-block` + 只在悬停时出现的复制按钮 | `ui/code-block` 的 `CodeBlock` |
| 未定义的 `progress-track` / `progress-fill`，以及渐变条 | `ui/meter` 的 `Meter` |
| 数据驱动的行内样式（条宽百分比、Combobox 的定位） | 保留 |

## 功能清单（Task 12 逐项验证；括号内为当前代码位置）

**列表与创建**

1. 管理员和普通用户（`canCreate`，KeysTab:17-19）可以看到名称输入框和 Create 按钮。
   - 回车提交。
   - 名称为空或正在创建时按钮禁用，此时文字为 `dash.creatingShort`。
   - 创建成功后清空输入框、选中新 key、刷新列表并打开"刚创建"对话框；失败时弹 toast。
2. 加载中且没有 key 时显示骨架行；加载完且没有 key 时显示 `dash.noApiKeys`。
3. 表格列依次为 Name、Owner、Key、Created、Last used、Actions，其中 Created 和 Last used 在 sm 以上才显示。
   - **修复：** 表头的 Actions 列现在只在 `canCreate` 时渲染，而每一行总有操作单元格（复制 key 对所有人可用），所以列会错位。改为表头始终渲染 Actions。
4. 行选择：
   - 点击一行切换选中，再点取消；选中的行有明显标记。
   - **修复：** 现在只能用鼠标选择。名称单元格改为 `<button type="button" aria-pressed>`，不另写 onClick，键盘回车或空格触发的 click 冒泡到行上处理，所以只切换一次。
   - 选中的 key 消失时自动取消选中。
5. Owner 单元格：
   - 显示 `owner_name`，没有时显示"—"；
   - 别人分享给我的 key 带 `dash.sharedBadge` 徽章；
   - 我拥有且已分享的 key 带 `dash.sharedWithCount` 徽章，title 列出被分享人的名字。
6. Key 显示为 `abcd…wxyz` 的掩码。Created 和 Last used 显示相对时间，title 为完整时间；从未用过的显示 `dash.never`。
7. 操作：
   - Requests：管理员可见，或者普通用户对自己的 key 可见；点击后打开该 key 的 RequestsPanel。
   - 复制 key：图标按钮，复制完整 key，2 秒内显示对勾，不弹 toast。
   - 删除：仅在可管理且 key 不是别人分享来的时显示；忙碌时禁用；弹原生确认框，删除后 toast `Deleted …`。
   - 图标按钮都要有 aria-label。

**刚创建对话框**

8. 显示完整 key 和 Copy 按钮，以及快速测试的 curl 示例、下一步提示、"Copy header"（复制 `Authorization: Bearer …`）和 Done。
   - 点遮罩、按 Esc 或点 Done 都能关闭；关闭后焦点回到页面；对话框打开时焦点锁在里面（由 Radix 提供）。

**分享**

9. 自己的 key：
   - 被分享人以徽章列出，每个带 × 按钮（title 为 `dash.unshareTip`）可以取消分享；
   - 邮箱输入框加 Share 按钮，回车也能提交，没有 `@` 时不提交；
   - 已有一个被分享人时，输入框和按钮都禁用，placeholder 和 title 为 `dash.shareUnshareFirst`；
   - toast 依次为 `Shared with …`、`Removed share`，失败时弹错误。
10. 别人分享来的 key：显示 SharedByOwnerPanel，内容是所有者徽章。

**配额**

11. 只有可编辑时（`(admin || user) && isOwned`）才显示 Edit。
12. 编辑表单：
    - requests、weighted tokens、cost 三个数字输入框（`min=0`，cost 的 `step=0.01`），各带"留空为不限"的提示；
    - 标签用 `htmlFor` 关联到输入框；
    - 空、0、负数或非数字都保存为不限；
    - Save 在忙碌时禁用，文字变为 `dash.savingShort`，成功后收起；Cancel 放弃修改。
13. 加载中显示 `role=status`（区分是否为旧数据）；出错显示 `role=alert`，带 Retry 按钮。
14. 三行用量：
    - 显示"已用 / 上限"，无上限时显示"/ ∞"；
    - **修复：** 进度条现在不可见（相关 CSS 类未定义），改用 Meter；
    - 颜色规则：超过 90% 为 danger，超过 70% 为 warn，否则为 brand；
    - 无上限时用对数刻度；
    - 显示剩余量，达到或超过 100% 时显示 `dash.quotaExceeded`。
15. 未加载用量时回退为"— / 上限"的文字。底部依次是未定价说明、已记录费用说明和加权公式；公式各部分不再上色。

**共享会话、响应保留**

16. 共享会话：
    - 只读模式显示 On 或 Off；
    - 编辑模式有开关、密钥框（placeholder 随状态变化）、Generate（64 位十六进制，生成后显示明文）、Reveal/Hide（框为空且服务端已配置时去拉取）、Copy（复制后变为 Copied）；
    - 格式不对时显示红色提示，并设置 `aria-invalid`，Save 禁用；
    - 有历史提示；
    - 失败时显示 `role=alert` 的 `dash.sharedSessionError`。
17. 响应保留：
    - 只读模式显示"N days"或 Off；
    - 编辑模式有开关、天数（1–3650，带 `aria-invalid`）、1/3/7 天预设（`aria-pressed`）；
    - 值无效时提示变红，关闭时显示禁用提示；
    - Save 在无效或忙碌时禁用。

**联网搜索**

18. 不在编辑模式且可编辑时，头部显示 Test 和 Edit。Test 运行中显示 `dash.wsTesting`；只读模式下显示测试结果，成功为 success、失败为 danger。
19. 编辑模式：
    - 启用复选框；
    - 四个引擎行 LangSearch、Tavily、Jina、MS Grounding，每行有三种状态：
      - 链接到其他 key：显示链接名，失效时显示 `dash.wsLinkUnavailable`，带 Unlink；
      - 已有掩码 key：带 Replace；
      - 否则是输入框加"Borrow from…"。
    - 输入框的标签用 `htmlFor` 关联。
20. 借用选择器：
    - 改为对话框，列出拥有该引擎 key 的其他 key（名称和所有者），点选后设为链接；Cancel、Esc 或点遮罩都能关闭。
    - **修复：** Jina 的候选现在按 `ms_grounding` 字段筛选（WS:107-114），改为按 Jina 字段筛选。
21. 透传：
    - upstream（仅 codex 或 custom）和 model 两个选择，改用 `ui/select` 并用 `labelledBy` 关联标签；
    - 更换 upstream 时清空 model；
    - 没有可用 upstream 时显示 warn 提示；
    - 两个都选了才保存，否则存 null。
22. 引擎优先级（仅管理员）：6 个引擎的编号列表，带上移和下移按钮（aria-label 含引擎名）以及 Reset；与默认相同时保存为 null。
23. 从其他 key 复制配置：选择（`ui/select`，带标签）加 Copy。成功后 toast "Web search config copied" 并退出编辑。
24. Save 在忙碌时禁用；Cancel。保存时链接、明文和清空的规则不变（WS:170-217）。
25. 只读模式：
    - 显示 Enabled 或 Disabled，以及透传的"upstream · model"；
    - 启用时显示：
      - 按优先级排列的引擎徽章，按 ref、broken、key、builtin、unset 区分颜色；
      - 1d/7d/30d 切换（SegmentedControl，驱动 store 的 `wsUsageRange`）；
      - 总计"N searches / ok / failed"；
      - 每个引擎的成功、空结果（含百分比）、失败和平均耗时。

**上游访问（测试契约见 Task 6）**

26. 头部：
    - 标题；
    - 原生复选框，`aria-label=dash.upstreamAccessToggleAria`，旁边显示 Enabled 或 Disabled；勾选后进入 custom 或 inherit 编辑；
    - Edit、Save、Cancel。Save 在已修改、未被阻塞、不忙碌时才可用；Edit 取决于 `can_manage_upstreams`。
27. 提示：共享提示和无效配置提示。
28. 编辑模式：
    - "Restore default"按钮和排序提示；
    - 加载中、加载出错（带 Retry）；
    - custom 模式下是 `<ul aria-label>`，每行有复选框、"n. 名称"、"id · provider"、启用或禁用标记、不可用警告；选中的行带上移和下移按钮（已有 aria-label）；
    - 无可选项提示、"Remove unavailable"提示、保存错误提示。
29. 只读模式：
    - custom 且有选择时显示"N selected · a → b"；
    - inherit 模式显示提示；
    - custom 但列表为空时显示 warn 的 `role=status`。
30. 选项在进入编辑时才加载，可以中止；保存的配置变化后草稿重置。

**模型映射**

31. 头部：
    - 启用复选框（带 aria-label），勾选后进入编辑；
    - Edit、Save、Cancel。Save 在未修改、忙碌或目录加载中时禁用，忙碌时文字为 `savingShort`；
    - 能否编辑取决于 `can_manage_model_mappings`；
    - 无效配置时显示 warn 提示。
32. 编辑模式每行：
    - Source 输入框（`htmlFor` 关联，失焦时校验）；
    - Destination 用 Combobox：
      - 有搜索 placeholder 和无匹配提示；
      - 不可用的选项带"unavailable"徽章并禁用；
      - upstream 名作为徽章和搜索关键词；
      - **可见标签用 `htmlFor` 或 `aria-labelledby` 关联**；
    - 字段错误在触碰过或尝试保存后显示：为空、过长（超过 256）、不可用；
    - 每行有拖拽手柄、上移、下移和删除按钮。
33. 超过 100 行时报错；达到 100 行时"Add mapping"禁用。保存时若有错误，标记为已尝试并阻止保存；保存成功后刷新目录；`keyRow` 变化时草稿重置。
34. 拖拽排序：
    - 指针拖拽用 pointer capture 加 `elementFromPoint` 定位行；
    - 拖动中源行变淡，目标行加环；
    - Esc、pointer cancel 或失去 capture 时恢复到拖拽前；
    - 手柄支持 ArrowUp 和 ArrowDown 排序。
35. 只读模式显示"source → destination"列表，为空时显示 `dash.modelMappingsEmpty`。

**客户端配置**

36. 显示信息行 `dash.configUsesSelectedKey`；目录加载中显示 `dash.loadingModels`。
37. 客户端切换 Claude Code、Codex、Gemini CLI，改用 SegmentedControl。
38. Claude：
    - model 和 small/fast model 两个选择；
    - Opus、Sonnet、Haiku 三档默认模型选择，都可以不选；
    - 禁用 artifact 的复选框；
    - 格式切换 Shell rc 或 settings.json（SegmentedControl），各自对应一个代码块。
39. Codex：一个 model 选择，下面是 config.toml、env、start 三个代码块；toml 取决于 WebSocket 能力探测的结果。
40. Gemini：一个 model 选择和一个代码块。所有选择都用 `ui/select`，并用 `labelledBy` 关联可见标签。
41. 选择值从目录生成，目录变化时重新校验。
42. 代码块的复制按钮：
    - **始终可见**，键盘可以聚焦；aria-label 和 title 为 Copy 或 Copied；
    - 复制后 2 秒内显示对勾；
    - toast 为 `dash.copiedToast`，失败时为 `dash.clipboardUnavailable`。
43. 其他可用模型：
    - 按 upstream 分组，带 provider 徽章；
    - 点击芯片复制模型 id，按住 Shift 点击复制 `upstream/model`，toast 为 `dash.copiedModelId`；
    - title 文字不变。

**一次性安装（Setup）**

44. Claude 和 Codex 标签下，`canSetup` 时显示。按 key、用户和标签重新挂载。
45. 选择项：
    - 平台：macOS/Linux 或 Windows/PowerShell；
    - 仅 Claude：effort 选择和 1M context 复选框；
    - 发放租约后全部锁定。
46. Preview 显示脱敏后的 JSON、SHA-256 和涉及的键；有当前预览后才显示 Mint；修改选择会使预览失效。
47. 租约：
    - 每秒刷新的过期时间（显示 Expires 或 Expired）；
    - 只读密码框和 Copy token；
    - 命令代码块，带 Copy command 和 Revoke；
    - "铸造后选择已变化"的警告（warn）。
48. 错误提示（danger）；复制状态是 `role=status` 的文字。

**请求记录（RequestsPanel）**

49. 标题 `dash.requests.title {name}`、范围说明和 Close 按钮。
50. 实时状态 `RequestsLiveStatus`（`role=status`）：范围文字、连续性说明、省略行数和 Refresh latest。
51. 列表出错、实时出错、加载中和空状态；`RequestsEmptyState` 在 4 种情况下返回空（见测试）。
52. 记录按钮显示 id、method · status · ms、path 和"捕获被省略"标记，带 `aria-expanded`；"Older / Loading more"分页。
53. 详情：
    - 记录标题和 Download；
    - 加载中、出错、省略原因；
    - 两列分别是原始客户端请求和规范化输出；
    - 二进制内容显示大小，并可切换显示或隐藏 base64。
    - **修复：** 5 个按钮现在用的是未定义的 `btn-secondary`，没有样式。

**权限（所有角色都要验证）**

54. 管理员、普通用户和只读用户分别能看到哪些控件，见盘点表：创建和 Actions、删除、Requests、Setup、配额等四个面板的编辑、上游和映射（服务端标志）、引擎优先级（仅管理员）、WS Test。

---

### Task 1: `src/ui` 第三批组件

**Files:**
- Create: `apps/dashboard/src/ui/dialog.tsx`、`apps/dashboard/src/ui/meter.tsx`、`apps/dashboard/src/ui/code-block.tsx`
- Modify: `apps/dashboard/src/ui/notice.tsx`（加 success 色调和 role 参数）
- Test: `apps/dashboard/src/ui/ui-batch3.test.tsx`

- [ ] **Step 1: 写失败的测试**

  `apps/dashboard/src/ui/ui-batch3.test.tsx`：

  ```tsx
  import { expect, test } from "bun:test"
  import { renderToStaticMarkup } from "react-dom/server"
  import { CodeBlock } from "./code-block"
  import { Meter, meterTone } from "./meter"
  import { Notice } from "./notice"

  test("Meter clamps its width to 0–100% and is decorative", () => {
    expect(renderToStaticMarkup(<Meter percent={140} />)).toContain("width:100%")
    expect(renderToStaticMarkup(<Meter percent={-5} />)).toContain("width:0%")
    expect(renderToStaticMarkup(<Meter percent={42} />)).toContain('aria-hidden="true"')
  })

  test("meterTone escalates at 70% and 90%", () => {
    expect(meterTone(70)).toBe("brand")
    expect(meterTone(70.1)).toBe("warn")
    expect(meterTone(90.1)).toBe("danger")
  })

  test("CodeBlock renders its copy button for keyboard users, named by the label", () => {
    const html = renderToStaticMarkup(<CodeBlock language="bash" text="echo hi" copyLabel="Copy" copied={false} onCopy={() => {}} />)
    expect(html).toContain("<pre")
    expect(html).toContain("echo hi")
    expect(html).toMatch(/<button[^>]*aria-label="Copy"/)
    expect(html).not.toContain("opacity-0")
  })

  test("Notice has a success tone, and the role can be overridden", () => {
    expect(renderToStaticMarkup(<Notice tone="success">ok</Notice>)).toContain("text-success")
    expect(renderToStaticMarkup(<Notice tone="warn" role="status">x</Notice>)).toContain('role="status"')
    expect(renderToStaticMarkup(<Notice tone="danger">x</Notice>)).toContain('role="alert"')
  })
  ```

  Dialog 依赖 Portal，静态渲染测不出内容，只在 Task 12 的浏览器验证里检查。

- [ ] **Step 2: 运行测试，确认因为模块不存在而失败**

  Run: `bun test apps/dashboard/src/ui/ui-batch3.test.tsx`
  Expected: FAIL（找不到 `./code-block`、`./meter`）

- [ ] **Step 3: 实现**

  `apps/dashboard/src/ui/meter.tsx`：

  ```tsx
  import { cn } from "./cn"

  export type MeterTone = "brand" | "warn" | "danger" | "muted"

  const FILL: Record<MeterTone, string> = {
    brand: "bg-brand",
    warn: "bg-warn",
    danger: "bg-danger",
    muted: "bg-fg-subtle",
  }

  /** The usage colour used by quota bars: brand up to 70%, warn above, danger above 90%. */
  export function meterTone(percent: number): MeterTone {
    if (percent > 90) return "danger"
    if (percent > 70) return "warn"
    return "brand"
  }

  /** A thin horizontal bar. Decorative: the text next to it carries the numbers. */
  export function Meter({ percent, tone = "brand", className }: { percent: number; tone?: MeterTone; className?: string }) {
    const width = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
    return (
      <div aria-hidden="true" className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
        <div className={cn("h-full rounded-full transition-[width]", FILL[tone])} style={{ width: `${width}%` }} />
      </div>
    )
  }
  ```

  `apps/dashboard/src/ui/code-block.tsx`（复制逻辑仍由调用方负责，toast 和 2 秒计时器都不变）：

  ```tsx
  import { Check, Copy } from "lucide-react"
  import { Button } from "./button"
  import { cn } from "./cn"

  interface Props {
    language: string
    text: string
    copyLabel: string
    copied: boolean
    onCopy: () => void | Promise<void>
    className?: string
  }

  export function CodeBlock({ language, text, copyLabel, copied, onCopy, className }: Props) {
    return (
      <div className={cn("relative", className)}>
        <pre className="overflow-x-auto whitespace-pre rounded-lg border border-border bg-muted p-3 pr-11 font-mono text-xs leading-relaxed text-fg">
          <code className={`language-${language}`}>{text}</code>
        </pre>
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-1.5 right-1.5"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={() => void onCopy()}
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </div>
    )
  }
  ```

  `apps/dashboard/src/ui/dialog.tsx`：

  ```tsx
  import * as RadixDialog from "@radix-ui/react-dialog"
  import type { ReactNode } from "react"
  import { cn } from "./cn"

  interface DialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: ReactNode
    description?: ReactNode
    children: ReactNode
    /** Buttons, right-aligned under the body. */
    footer?: ReactNode
    className?: string
  }

  /** A centred modal: Esc and a click outside close it, focus is trapped and returned (Radix). */
  export function Dialog({ open, onOpenChange, title, description, children, footer, className }: DialogProps) {
    return (
      <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <RadixDialog.Content
            {...(description ? {} : { "aria-describedby": undefined })}
            className={cn(
              "fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-lg focus:outline-none",
              className,
            )}
          >
            <div className="space-y-1">
              <RadixDialog.Title className="text-base font-semibold text-fg">{title}</RadixDialog.Title>
              {description ? <RadixDialog.Description className="text-[13px] text-fg-muted">{description}</RadixDialog.Description> : null}
            </div>
            {children}
            {footer ? <div className="flex flex-wrap justify-end gap-2">{footer}</div> : null}
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    )
  }
  ```

  `apps/dashboard/src/ui/notice.tsx` 改为：

  ```tsx
  import type { AriaRole, ReactNode } from "react"
  import { cn } from "./cn"

  const TONES = {
    info: "border-border bg-panel text-fg-muted",
    success: "border-success/30 bg-success/10 text-success",
    warn: "border-warn/30 bg-warn/10 text-warn-text",
    danger: "border-danger/30 bg-danger/10 text-danger-text",
  } as const

  /** An inline message. Danger notices are announced (role=alert) unless a role is given; the others are not. */
  export function Notice({ tone = "info", role, className, children }: { tone?: keyof typeof TONES; role?: AriaRole; className?: string; children: ReactNode }) {
    return (
      <div role={role ?? (tone === "danger" ? "alert" : undefined)} className={cn("rounded-md border px-3 py-2 text-[13px]", TONES[tone], className)}>
        {children}
      </div>
    )
  }
  ```

  如果 success 色在淡底上的对比度不足 4.5（浅色主题），在 `styles.css` 里照 `--warn-text` 的做法加一个 `--success-text`，并在 `@theme inline` 里注册 `--color-success-text`。之后 success 的 Notice 和 Badge 改用 `text-success-text`。

- [ ] **Step 4: 运行测试，确认通过**

  Run: `bun test apps/dashboard/src/ui`
  Expected: PASS

- [ ] **Step 5: 类型检查和 lint**

  Run: `cd apps/dashboard && bun run typecheck`，以及在 vnext 根目录运行 `bun run lint`
  Expected: 无错误

---

### Task 2: 页面外框、列表和行

**Files:**
- Modify: `apps/dashboard/src/tabs/keys/KeysTab.tsx`、`apps/dashboard/src/tabs/keys/KeyRow.tsx`

- [ ] **Step 1:** 页头：
  - 用 `<PageHeader title={t("dash.apiKeys")} actions={…}>` 替换原来的卡片标题 h3；
  - 创建表单（名称输入框和 Create 按钮）放进 `actions`；
  - 输入框外包一层定宽 div（例如 `w-full sm:w-56`），删掉 `sm:w-40!`；
  - 输入框没有可见标签，aria-label 用 placeholder 那个 `t()` 键；
  - Create 用 `<Button variant="primary">`，禁用条件和文字切换不变。
- [ ] **Step 2:** 表格：
  - 外面是 `<Card>`，里面用 `ui/table` 的 `Table label={t("dash.apiKeys")}`、`Th`、`TBody`、`Td`；
  - Created 和 Last used 两列仍为 `hidden sm:table-cell`；
  - **表头始终渲染 Actions 列**（修复列错位）；
  - 骨架行用 `bg-muted animate-pulse`；
  - 空状态用 `<EmptyState title={t("dash.noApiKeys")} />`。
- [ ] **Step 3:** `KeyRow`：
  - 行的底色和悬停：`border-b border-border hover:bg-muted/60`；选中时 `bg-muted`，名称前面用品牌色圆点；
  - 名称包在 `<button type="button" aria-pressed={selected}>` 里，不加 onClick（见功能清单第 4 项）；样式用 `text-left font-medium text-fg` 加焦点样式；
  - 两个徽章用 `<Badge tone="brand">`（shared）和 `<Badge tone="success">`（shared with N，带 title）；
  - key 掩码用 `font-mono text-xs text-fg-muted`；
  - 日期用 `tabular-nums text-fg-muted`，保留 title；
  - Requests 用 `<Button variant="ghost" size="sm">`；
  - 复制和删除用 `<Button variant="ghost" size="icon-sm">`，图标为 lucide 的 `Copy`/`Check`（success 色）和 `Trash2`（悬停时 `hover:text-danger`）；aria-label 和 title 用原来的 `dash.copyKey` 和 `dash.deleteKey`；
  - 删掉 `hover:text-accent-violet!` 和 `hover:text-accent-red!`；
  - 所有操作按钮保留原有的 `stopPropagation`（先核对现状），避免点击时切换选中。
- [ ] **Step 4:** 选中 key 后，`KeyDetailPanel` 和 `RequestsPanel` 仍按原顺序挂在表格下方，本任务不改。
- [ ] **Step 5:** 运行 `bun test apps/dashboard`、类型检查和 lint；对照功能清单第 1–7 项自查并写进报告。

---

### Task 3: 刚创建对话框

**Files:**
- Modify: `apps/dashboard/src/tabs/keys/JustCreatedKeyModal.tsx`

- [ ] **Step 1:** 改用 `ui/dialog` 的 `Dialog`：
  - `open` 恒为 true（父组件按 `store.justCreated` 决定是否渲染），`onOpenChange(false)` 调原来的关闭函数；
  - 标题为 `dash.keyCreatedTitle`；
  - footer 里放"Copy header"（secondary）和 Done（primary）；
  - 删掉手写遮罩、`glass-card` 和 `glow-primary`。
- [ ] **Step 2:** 正文：
  - 完整 key 用 `font-mono text-xs`，放在 `bg-muted border border-border rounded-md` 的框里，可以换行；旁边是 Copy 按钮（secondary sm）；
  - 快速测试小标题 `dash.quickTestCurl` 用 h3；curl 示例改用 `ui/code-block`，复制时把 curl 文本写入剪贴板，标签用 `dash.copy`；
  - 下一步提示用 `text-[13px] text-fg-muted`。
- [ ] **Step 3:** 复制反馈：
  - Copy 和 Copy header 都使用 `helpers.copyToClipboard`；
  - 成功后按钮里 2 秒显示对勾图标（文字不变）；
  - 失败时 toast `dash.clipboardUnavailable`（该键已存在）。
- [ ] **Step 4:** 运行测试、类型检查和 lint；对照第 8 项自查。

---

### Task 4: 分享与配额

**Files:**
- Modify: `apps/dashboard/src/tabs/keys/AssigneesPanel.tsx`、`apps/dashboard/src/tabs/keys/QuotaEditor.tsx`

- [ ] **Step 1:** `AssigneesPanel` 和 `SharedByOwnerPanel`：
  - 改用 `Card` 加 `SectionHeading`（h2，文案键不变）；
  - 被分享人和所有者用 `Badge`；
  - × 按钮改为 lucide 的 `X`，放在 `Button ghost icon-sm` 里，aria-label 和 title 都是 `dash.unshareTip`；
  - 邮箱输入框外包一层定宽 div，aria-label 用 placeholder 的键；Share 用 primary sm；
  - 禁用条件、title 和回车提交都不变。
- [ ] **Step 2:** `QuotaEditor` 的编辑表单：
  - 三个字段用 `useId` 生成 id，`<label htmlFor>` 关联输入框；
  - 提示用 `text-xs text-fg-subtle`；
  - 按钮按映射规则替换。
- [ ] **Step 3:** 三行用量：
  - 抽出一个本文件内的 `UsageRow` 组件（label、used、limit、format 函数），去掉三段重复代码；
  - 条用 `Meter`：有上限时 `tone={meterTone(pct)}`；无上限时沿用原来的对数刻度，`tone="muted"`；
  - 删除渐变和 `progress-*` 类；
  - `dash.quotaExceeded` 用 `text-danger`，数字用 `tabular-nums`。

  **先跑一遍现状，记下各个边界值的显示文字，改完后逐一核对：** 0、70%、90%、100%、超过 100%、无上限、未加载。
- [ ] **Step 4:** 加载中用 `<Notice role="status">`；出错用 `<Notice tone="danger">`，里面放 Retry（ghost sm）。底部说明用 `text-xs text-fg-subtle`；公式各部分统一用 `text-fg`，不再使用 `part.colorClass`（`weighted-formula.ts` 本身不改）。分隔线用 `border-border`。
- [ ] **Step 5:** 运行测试、类型检查和 lint；对照第 9–15 项自查。

---

### Task 5: 共享会话与响应保留

**Files:**
- Modify: `apps/dashboard/src/tabs/keys/SharedSessionPanel.tsx`、`apps/dashboard/src/tabs/keys/ResponsesRetentionPanel.tsx`

- [ ] **Step 1:** 两个面板都改用 `Card` 加 `SectionHeading`（h2）。原来 section 上的 `aria-labelledby` 继续指向标题的 id。
- [ ] **Step 2:** 开关保留原生 `checkbox role=switch`，颜色用 `accent-brand`；按钮按映射规则替换。
- [ ] **Step 3:** 共享会话：
  - 密钥框用 `font-mono`；
  - 无效时的提示用 `text-danger`，`aria-invalid` 和 `aria-describedby` 不变；
  - 错误改用 `<Notice tone="danger">`。
- [ ] **Step 4:** 响应保留：
  - 天数输入框外包一层定宽 div（例如 `w-28`）；
  - 1/3/7 预设保留为 `aria-pressed` 的按钮：选中时 `Button variant="primary" size="sm"`，否则 `secondary sm`；
  - 无效提示用 `text-danger`。
- [ ] **Step 5:** 运行测试、类型检查和 lint；对照第 16–17 项自查。

---

### Task 6: 上游访问

**Files:**
- Modify: `apps/dashboard/src/tabs/keys/UpstreamAccessPanel.tsx`
- Test（只读，不得放宽）: `apps/dashboard/src/tabs/keys/UpstreamAccessPanel.test.tsx`

- [ ] **Step 1:** 先读测试，确认这些契约不变：
  - Edit 是 `<button>`，且它的文本节点直接是 `t("dash.edit")`，即 HTML 中出现 `>dash.edit</button>`。`Button` 组件渲染的是原生 `<button>`，只要不在文字前后加图标或 span 就满足；
  - 开关是带 `aria-label="dash.upstreamAccessToggleAria"` 的原生 `<input>`，`checked` 和 `disabled` 属性不变；
  - 各提示键都在。
- [ ] **Step 2:** 改用 `Card` 加 `SectionHeading`（h2），`aria-labelledby` 保留。复选框用 `accent-brand`；按钮按映射规则替换。
- [ ] **Step 3:** 提示和警告改用 `Notice`：
  - 无效配置、"Remove unavailable"、custom 但为空：tone 用 warn，原来带 `role=status` 的继续保留；
  - 加载出错（带 Retry）、保存出错：tone 用 danger。
- [ ] **Step 4:** 列表行：
  - 选中行 `bg-muted`；provider 和 id 用 `text-xs text-fg-subtle font-mono`；
  - 启用或禁用标记用 `Badge`；
  - ↑↓ 改为 `ChevronUp`、`ChevronDown`，放在 `Button ghost icon-sm` 里，aria-label 不变；
  - 只读摘要里的 `→` 保留。
- [ ] **Step 5:** 运行 `bun test apps/dashboard/src/tabs/keys/UpstreamAccessPanel.test.tsx`（必须原样通过），再跑全部测试、类型检查和 lint；对照第 26–30 项自查。

---

### Task 7: 模型映射与 Combobox

**Files:**
- Modify: `apps/dashboard/src/tabs/keys/ModelMappingsPanel.tsx`、`apps/dashboard/src/components/Combobox.tsx`

- [ ] **Step 1:** `Combobox` 只改样式，不改键盘逻辑和定位逻辑：
  - 触发按钮或输入框用 `border border-input bg-background`，加实线焦点样式，删掉 `focus:border-accent-violet/50!` 和 `border-white/*`；
  - 弹层用 `border-border bg-background shadow-lg`；
  - 高亮项用 `bg-muted`，选中项用 `text-brand-text`；
  - 徽章用 `Badge`；
  - 字号 `text-xs` 和 `text-[13px]`；删掉 `scrollbar-thin`。

  如果 Combobox 还没有 `labelledBy` 参数，就加一个，用于把字段标签设成 `aria-labelledby`，与现有 aria-label 二选一。
- [ ] **Step 2:** 面板改用 `Card` 加 `SectionHeading`（h2）。启用复选框用 `accent-brand`。无效提示用 `<Notice tone="warn">`。
- [ ] **Step 3:** 每行：
  - Destination 的可见标签加 id，通过 `labelledBy` 关联到 Combobox；aria-label 的文案保留，作为没有可见标签时的后备；
  - 字段错误用 `text-xs text-danger`；
  - 拖拽手柄用 `GripVertical`，上移和下移用 `ChevronUp`、`ChevronDown`，删除用 `X`，都放在 `Button ghost icon-sm` 里，aria-label 和 title 不变；
  - `enabled:active:cursor-grabbing!` 改为在手柄外层处理，或者直接用 `cursor-grab active:cursor-grabbing`（Button 不在 layer 冲突里，所以不需要 `!`）；
  - 拖动中的源行用 `opacity-50`，目标行用 `ring-2 ring-brand-text`；
  - **pointer 事件、`data-mapping-row-id`、Esc 恢复和方向键排序的代码一行都不动。**
- [ ] **Step 4:** 只读列表显示"source → destination"，source 和 destination 用 `font-mono text-xs`，空列表文字不变。"Add mapping"用 secondary sm，"too many"错误用 `text-danger`。
- [ ] **Step 5:** 运行测试（含 `combobox-state`、`model-mappings-*`）、类型检查和 lint；对照第 31–35 项自查。

---

### Task 8: 联网搜索·只读、测试和用量

**Files:**
- Modify: `apps/dashboard/src/tabs/keys/WebSearchPanel.tsx`（只改只读模式、头部、测试结果和用量部分，即约 240–260 行和 474–610 行）
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts`（新增 aria 键）

- [ ] **Step 1:** 外层改用 `Card` 加 `SectionHeading`（h2）；头部的 Test、Edit、Save、Cancel 按映射规则替换，Test 运行中的文字不变。
- [ ] **Step 2:** 测试结果改用 Notice：成功时 tone 为 success，内容依次是 `dash.wsTestOk`、示例查询和第一条结果标题；失败时 tone 为 danger。
- [ ] **Step 3:** 只读状态：
  - Enabled 和 Disabled 用 `Badge`（success 或 neutral）；
  - 透传说明用 `font-mono text-xs`；
  - 引擎徽章的 5 种状态映射为：ref 用 brand，broken 用 danger，key 用 success，builtin 用 neutral，unset 用 neutral 加 `opacity-60`；文字和顺序不变。
- [ ] **Step 4:** 1d/7d/30d 改用 `SegmentedControl size="sm"`：
  - 选项文字仍是 "1d"、"7d"、"30d"；
  - `ariaLabel={t("dash.wsUsageRangeAria")}`，在 i18n 中新增：en "Web search usage range"，zh "联网搜索用量范围"；
  - onChange 调原来的 store 方法。
- [ ] **Step 5:** 用量统计：
  - 总计和每个引擎的统计数字用 `tabular-nums`；
  - ok 用 `text-success`，fail 用 `text-danger`，empty 用 `text-warn-text`；
  - 每个引擎一行，用 `border-b border-border` 分隔；
  - 写死的英文保持不变。
- [ ] **Step 6:** 运行测试（含 i18n-keys）、类型检查和 lint；对照第 18 项和第 25 项自查。

---

### Task 9: 联网搜索·编辑模式与借用对话框

**Files:**
- Modify: `apps/dashboard/src/tabs/keys/WebSearchPanel.tsx`（编辑模式，约 270–472 行；`EngineEditorRow` 在 617–681 行；候选筛选在 100–120 行）
- 可选：把 `EngineEditorRow` 和借用对话框拆成 `WebSearchEngineRow.tsx`、`WebSearchBorrowDialog.tsx`
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts`（如需新增 aria 键）
- Test: `apps/dashboard/src/tabs/keys/web-search-borrow.test.ts`（新建）

- [ ] **Step 1: 先为 Jina 的 bug 写失败的测试**

  把 WS:100-120 中计算借用候选的逻辑提取成一个纯函数，例如 `borrowCandidates(engine, keys, selfId)`，放到新文件 `tabs/keys/web-search-borrow.ts`。函数签名以现有代码为准。

  测试内容：给定若干 key，一个只有 Jina key、一个只有 MS Grounding key，断言 Jina 的候选只包含前者，MS Grounding 的候选只包含后者；另外断言当前 key 自己不在候选里。

  Run: `bun test apps/dashboard/src/tabs/keys/web-search-borrow.test.ts`。在提取的函数保留原有 bug 的情况下应 FAIL；修正为按 Jina 字段筛选后 PASS。
- [ ] **Step 2:** 借用选择器改为 `ui/dialog` 的 `Dialog`：
  - 标题 `dash.wsBorrowFromTitle`；
  - 列表每项是一个全宽的 `button`，显示名称和所有者，悬停为 `hover:bg-muted`，带焦点样式；
  - footer 里放 Cancel（ghost）；
  - 删掉手写遮罩。
- [ ] **Step 3:** `EngineEditorRow`：
  - 标签用 `useId` 生成 id，通过 `htmlFor` 关联输入框；
  - 链接状态用 `Link2` 图标加名称，失效时用 `text-danger`；
  - Unlink、Replace、"Borrow from…"用 ghost sm；
  - 输入框外不再加 `!`；
  - MS Grounding 那一行仍占满整行。
  - `tStatic("dash.wsLinkUnavailable")` 改为响应式的 `t`（通过参数或 hook 传入），语言切换后要能更新。
- [ ] **Step 4:** 透传和复制来源：
  - 三处 `components/Select` 改为 `ui/select`；
  - 可见标签加 id，通过 `labelledBy` 关联；
  - 原来值为 `""` 的"不选"选项照常使用（`ui/select` 会映射为哨兵值）；
  - 没有可用 upstream 时用 `<Notice tone="warn">`；
  - Copy 用 secondary sm。
- [ ] **Step 5:** 引擎优先级（仅管理员）：
  - 列表行用 `border-b border-border`，编号用 `tabular-nums text-fg-subtle`，引擎 id 用 `font-mono`；
  - ▲▼ 改为 `ChevronUp`、`ChevronDown`，放在 `Button ghost icon-sm` 里，title 不变；
  - aria-label 为 `` `${t("dash.wsUpTitle")} ${engine}` ``，下移同理，这样不用加新键；
  - Reset 用 ghost sm。
- [ ] **Step 6:** 启用复选框用 `accent-brand`。保存逻辑（WS:160-217）不动。
- [ ] **Step 7:** 运行测试、类型检查和 lint；对照第 19–24 项自查。

---

### Task 10: 客户端配置与一次性安装

**Files:**
- Modify: `apps/dashboard/src/tabs/keys/ConfigurationPanel.tsx`、`apps/dashboard/src/tabs/keys/SetupPanel.tsx`
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts`（新增 aria 键）

- [ ] **Step 1:** `ConfigurationPanel`：
  - 改用 `Card` 加 `SectionHeading`（h2）；
  - 信息行用 lucide 的 `Info` 图标和 `text-[13px] text-fg-muted`；
  - 删除本文件中的 `CodeBlock`，改用 `ui/code-block`，`copyLabel` 根据 copied 取 `dash.codeCopyTipCopied` 或 `dash.codeCopyTipCopy`；`doCopy` 不变。
- [ ] **Step 2:** 客户端切换改用 `SegmentedControl`，选项文字仍是 "Claude Code"、"Codex"、"Gemini CLI"，`ariaLabel={t("dash.configClientAria")}`。i18n 中新增：en "Client"，zh "客户端"。

  格式切换（Shell rc / settings.json）也改用 SegmentedControl，`ariaLabel={t("dash.configFormatAria")}`。i18n 中新增：en "Config format"，zh "配置格式"。
- [ ] **Step 3:** 全部 5–7 个 `components/Select` 改为 `ui/select`：
  - 每个可见标签加 id，通过 `labelledBy` 关联，包括原来没有关联的 Codex 和 Gemini 两个；
  - 原来用 ariaLabel 但没有可见标签的，继续用 ariaLabel；
  - Opus、Sonnet、Haiku 的"不选"选项值为 `""`。
- [ ] **Step 4:** "其他可用模型"：
  - 小标题用 h3；
  - provider 徽章改为 `Badge`：原来蓝色的用 `tone="brand"`，紫色的用 `tone="neutral"`。先读现有代码确认颜色分别对应哪个 provider；
  - 芯片是 `button`，样式 `border border-control bg-background hover:bg-muted font-mono text-xs rounded-md px-2 py-0.5`，加焦点样式；
  - title 和 Shift 点击的行为不变。
- [ ] **Step 5:** `SetupPanel`：
  - 区域标题由 h4 改为 h3（`aria-label` 保留）；
  - 平台和 effort 两个原生 `<select>` 改为 `ui/select`，选项值和文字不变，锁定时 `disabled`；
  - 1M context 复选框用 `accent-brand`；
  - Preview、Mint、Copy token、Copy command 用 secondary sm，Revoke 用 danger sm；删除本地按钮类；
  - 预览 JSON 和命令用 `ui/code-block`（复制按钮的行为与原来的 Copy command 一致），或者保留 `<pre>` 加 token 样式，二选一，不能丢掉原来的任何一个按钮；
  - 警告用 `Notice tone="warn"`，错误用 `Notice tone="danger"`；
  - 过期时间用 `tabular-nums`。
- [ ] **Step 6:** 运行测试（含 `config-snippets`、`codex-capability`、`setup-state`）、类型检查和 lint；对照第 36–48 项自查。

---

### Task 11: 请求记录与详情区布局

**Files:**
- Modify: `apps/dashboard/src/tabs/requests/RequestsPanel.tsx`、`apps/dashboard/src/tabs/keys/KeyDetailPanel.tsx`
- Test（只读，不得放宽）: `apps/dashboard/src/tabs/requests/RequestsPanel.test.tsx`

- [ ] **Step 1:** `RequestsPanel`：
  - 改用 `Card` 加 `SectionHeading`（h2）；
  - 5 个 `btn-secondary` 改为 `Button variant="secondary" size="sm"`；
  - 列表出错用 `Notice tone="danger"`；实时出错原来是 status，改用 `Notice tone="warn" role="status"`；
  - 记录按钮用 `hover:bg-muted`，展开时 `bg-muted`，数字用 `tabular-nums`，`aria-expanded` 保留；
  - 记录标题 h4 改为 h3，raw 和 canonical 的 h5 改为 h4；
  - 头部和正文用 `font-mono text-xs bg-muted border border-border rounded-md`。
  - `RequestsLiveStatus` 和 `RequestsEmptyState` 的导出、`role="status"` 和返回空的条件都不变。
- [ ] **Step 2:** `KeyDetailPanel`：
  - 各卡片的顺序和挂载条件都不变；外层用 `space-y-4`，或者 `flex flex-col gap-4`；
  - 不改为侧滑面板，也不改成两列：卡片高度差别很大，单列最稳。
- [ ] **Step 3:** 全组标题层级自查，期望为 h1（页面）→ h2（每张卡片）→ h3（卡片内小节、对话框内小标题）→ h4（请求详情的两栏）。用 `grep -n "<h[1-6]\|SectionHeading" apps/dashboard/src/tabs/keys apps/dashboard/src/tabs/requests -r` 列出并写进报告。
- [ ] **Step 4:** 运行 `bun test apps/dashboard/src/tabs/requests`（必须原样通过），再跑全部测试、类型检查和 lint；对照第 49–53 项自查。

---

### Task 12: 浏览器验证与全量检查（主控执行）

- [ ] **Step 1:** 残留扫描。以下命令在 `tabs/keys`、`tabs/requests` 和 `components/Combobox.tsx` 中应当无输出：

  ```bash
  cd apps/dashboard/src
  grep -rnE "glass-card|btn-(primary|ghost|secondary)|text-\[1[01]px\]|border-white/|bg-white/|bg-surface-|accent-(violet|teal|red|amber|cyan)|progress-(track|fill)|animate-in|glow-primary|code-block|[a-z]!(\s|\"|$)" tabs/keys tabs/requests components/Combobox.tsx | grep -v test
  ```

  若某处必须保留，在报告里说明原因。
- [ ] **Step 2:** 在 worktree 中以临时数据库启动本地 Bun 网关（与第一组相同的方式），用管理员登录：
  - 逐项走查功能清单第 1–53 项，深色和浅色主题各看一遍；
  - 对话框重点验证：Esc 关闭、焦点锁定、关闭后焦点回到页面；借用对话框的 Jina 候选正确；
  - 键盘：Tab 走一遍列表和各面板，确认行选择可以用键盘完成，代码块的复制按钮可以聚焦；
  - 手机宽度（390px）下检查表格、创建表单和对话框。
- [ ] **Step 3:** 用普通用户和只读用户各登录一次，核对第 54 项的权限差异。
- [ ] **Step 4:** Lighthouse 无障碍评分：Keys 页（选中一个 key 展开全部面板）目标为 100。
- [ ] **Step 5:** 全量检查：`bun run ci:local`。已知的 `reference-adapter` 和负载超时这两项失败不计。
- [ ] **Step 6:** 把评审中发现、但不在本组范围内的问题追加到 `.superpowers/sdd/dashboard-redesign/phase2-followups.md`，包括删除确认和 `timeAgo` 的 i18n、toast 的色板。
