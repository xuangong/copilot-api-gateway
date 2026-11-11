# Dashboard 重设计第二期·第一组：用量、延迟 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"用量"和"延迟"两页迁移到新组件和新设计规范上，功能一个不少。

**Architecture:**
1. 先在 `src/ui/` 补齐两页需要的组件：页面标题区、卡片、分段切换、单选、多选、表格、徽章、空状态、提示条。
2. 再按"映射规则"逐个文件替换控件和样式类，页面结构、字段、文案和接口调用都不变。
3. 最后按功能清单在浏览器里逐项验证。

**Tech Stack:** React 19、Tailwind 4.3、Radix（select、dropdown-menu、tooltip）、lucide-react、bun test（`renderToStaticMarkup`，无 DOM）。

**Spec:** `docs/superpowers/specs/2026-11-11-dashboard-redesign-design.md`（第三章"第二期"）

---

## 背景（实现者必读）

- 工作目录是 worktree `/Volumes/Projects/copilot-api-gateway/.worktrees/dashboard-observe/vnext`，分支 `feat/vnext-dashboard-redesign-observe`，基于 `adfd2925`（第一期）。**不要提交，不要 `git stash`**，由主控统一提交。
- `@radix-ui/react-select@^2.4.1` 已经装好。如需再装包：`BUN_CONFIG_REGISTRY=https://mirrors.cloud.tencent.com/npm/ bun add --backend=copyfile <pkg>`，装完执行 `sed -i '' -E 's#"https://mirrors\.cloud\.tencent\.com/npm/[^"]*"#""#g' bun.lock`，确保 lockfile 里不留镜像地址。
- 设计 token 定义在 `apps/dashboard/src/styles.css` 的 `@theme inline`：
  - 背景和表面：`bg-background`、`bg-panel`、`bg-muted`
  - 文字：`text-fg`、`text-fg-muted`、`text-fg-subtle`
  - 边框：`border-border`、`border-input`（输入框边界）、`border-control`（按钮、芯片）
  - 品牌色：`bg-brand`、`text-brand-text`
  - 状态色：`text-success`、`text-warn`、`text-danger`、`text-info`

  焦点样式统一为 `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text`。
- **层级规则：** v4 中不在 layer 里的 CSS 会压过所有工具类。`styles.css` 里的全局 `input[type=text|password|email|number|url]` 和 `input:focus` 规则不在 layer 里，会覆盖这些输入框上的 padding、边框、圆角、字号和宽度。新组件不要和它们较劲：输入框直接用原生 `<input>`，吃全局样式即可。
- 第一期已有的组件：`ui/button.tsx`（Button：variant primary/secondary/ghost/danger，size sm/md/icon）、`ui/tooltip.tsx`、`ui/dropdown-menu.tsx`、`ui/sheet.tsx`、`ui/cn.ts`。
- 测试：`bun test apps/dashboard`；类型检查：`cd apps/dashboard && bun run typecheck`；lint：在 vnext 根目录 `bun run lint`；构建：`bun run build:ui`。新增或改动的字面量 `t("…")` 键必须在 `packages/gateway/src/shared/edge/ui-pages/i18n.ts` 中英文两份字典里都存在（`packages/gateway/tests/i18n-keys.test.ts` 会检查）。
- **文案不改。** 页面里写死的英文（例如 "Cache"、" req"、"Previous day"）保持原样，留到后面统一处理。

## 映射规则（Task 2–6 通用）

| 旧写法 | 新写法 |
|---|---|
| 页面顶部卡片里的大写标签（如 Usage 的 "USAGE"）或 `h2` 页面标题 | `<PageHeader title=… description=… actions=…>`（h1）；原来的标签删除 |
| `glass-card` 容器 | `<Card>` |
| 大写的分节标签（`uppercase tracking-widest`，例如 "MODEL DISTRIBUTION"） | `<SectionHeading>`：普通大小写的 h2，`text-sm font-semibold text-fg`，文案键不变 |
| 字段标签（`text-[11px] uppercase`） | `text-xs font-medium text-fg-muted`，不再大写 |
| `text-[10px]`、`text-[11px]` | `text-xs`（12px） |
| 数字上的 `font-mono` | `tabular-nums`，不用 `font-mono`；表格数字列用 `<Td numeric>` |
| `text-themed` / `text-themed-secondary` / `text-themed-dim` | `text-fg` / `text-fg-muted` / `text-fg-subtle` |
| `border-themed`、`border-white/N`（非输入框） | `border-border` |
| 自定义下拉、输入框的 `border-white/N` | 改用 `ui/select`；原生输入框靠全局样式，删除边框类 |
| `bg-surface-800` / `bg-surface-700` / `bg-surface-600`（作为表面、悬停、选中） | `bg-panel` / `bg-muted` / 选中项按组件处理 |
| `text-accent-red`、`text-red-400` | `text-danger` |
| `text-green-400`、`text-accent-teal` | `text-success` |
| `amber-400`（文字、边框、ring） | `warn`（`text-warn`、`border-warn`、`ring-warn`） |
| `text-accent-violet`（文字） | `text-brand-text` |
| 页面里自写的分段按钮（`SegmentedGroup`、Latency 的范围按钮） | `<SegmentedControl>` |
| `components/Select` | `ui/select` 的 `Select`。`components/Select.tsx` 本身保留，Models 和 Keys 页还在用 |
| `components/MultiSelect` | `ui/multi-select`；迁完后删除旧文件 |
| 文字字形图标 `‹` `›` `▴` `▾` `▶` | lucide 图标 `ChevronLeft`、`ChevronRight`、`ChevronUp`、`ChevronDown`，放在 `<Button variant="ghost" size="icon">` 里，保留原 `title`、`aria-label` 和禁用条件 |
| 自写的提示气泡（CSS `.tip` / `data-tip`、focusable span 加 popover） | `ui/tooltip` 的 `Tooltip`；触发元素用真正的 `<button type="button">`，并带 aria-label |
| 第一期为保持 v3 行为加的 `focus:border-surface-600!`、`hover:text-accent-violet!` 等 | 控件换成新组件后删除；原生输入框上的这类 `!` 一并删除，改用全局 focus 样式 |
| 数据驱动的行内样式（宽度百分比、调色板颜色、浮层坐标） | 保留 |
| 数据可视化配色（`paletteFor`、RollingStrip 的色阶数组） | 保留 |

## 功能清单（Task 7 逐项验证；括号内为当前代码位置）

**用量（Usage）**

1. 刷新：
   - 刷新按钮重新拉取数据，拉取期间图标旋转、按钮禁用（`UsageRefresh.tsx:42-62`）。
   - 自动刷新可选 Off、1、5、15、30 分钟，存储在 `localStorage` 的 `usage.autoRefreshMin`；开启时控件高亮。
   - 显示"刚刚 / N 分钟前 / N 小时前"。
   - 浏览器标签页隐藏时不轮询。
2. 指标切换 Tokens / Requests，默认 Tokens。
3. 范围切换 Day / Week / Month / 28 Days，默认 Day。切换后周期偏移归零；离开 28 天时清除结束日期。
4. 时区切换"Local（UTC±x）/ UTC"，存储在 `usage.timeZone`。延迟页也读这个设置，所以控件必须保留。
5. 周期步进（Day、Week、Month）：
   - 前一个、后一个，到当前周期时"后一个"禁用；
   - 中间的标签文字不变；
   - 按钮有 title 和 aria-label。
6. 28 天窗口：
   - 结束日期输入框（max 为今天，清空后回到滚动窗口）；
   - 窗口跨度标签；
   - "Latest window" 按钮（仅在固定了结束日期时显示）；
   - 滚动区开关（带 `aria-expanded`，默认收起，存储在 `usage.stripOpen`，收起时清除预测高亮）。
7. 滚动条带：
   - 90 个方格，点击方格把结束日期固定到那一天；
   - 悬停或聚焦时显示浮层（日期、28 天费用和 tokens、当天费用和 tokens）；
   - 有图例；
   - 选中日有环，被预测高亮的日子用 warn 色环，其余方格变淡；
   - 方格的 aria-label 不变。
8. 预测：
   - 预算输入框（默认 10000，min 0，step 100）；
   - 最多 3 行；超支时显示 danger 色金额；
   - 悬停或聚焦某一行时，条带上高亮对应日期，移开后清除。
9. 筛选：
   - 用户（仅管理员，且有用户时才显示）、Key（共享 Key 带徽章）、客户端、路由模型、传入模型；
   - 筛选之间不联动；
   - 共享用量说明；
   - "清除筛选"按钮仅在有筛选时显示；
   - 筛选提示文字（仅在有数据时显示）。
10. 图表：
    - 管理员未选用户时按用户分线，否则按模型分线；说明文字随之变化；
    - 按模型分线时显示 routed/incoming 切换，它与下方分布表共用同一个状态；
    - 图例点击可显示或隐藏线，选择在刷新后保留；
    - 悬停提示按值排序，带缓存占比和费用，底部有总费用；
    - 日粒度图表点击某一点打开那一天（"View this day"），浏览器后退能回到原来的视图；
    - 时区脚注。
11. 汇总 8 格：
    - 2 列，md 以上 4 列；
    - Cache read 有命中率；
    - Total tokens 旁的信息按钮显示加权 tokens 浮层（悬停和键盘聚焦都能打开）；
    - Cost 为零时显示 "—"。
12. 分布：
    - routed/incoming 切换；
    - 依次为按模型、按用户（仅管理员）、按 Key、按客户端，incoming 时多一列 "Routed models"；
    - 被筛选的维度对应的表隐藏；
    - 每张卡片：三条占比条、悬停联动高亮、读数行、各段带 title。
13. 无数据时显示 "No usage in range"（仅在未筛选、未加载、数据为空时）；主请求出错弹 toast。
14. 非管理员看不到：用户筛选、按用户表、共享说明、按用户分线。

**延迟（Latency）**

15. 页面标题和说明（`dash.perf.experience.title` / `.scope`）。
16. 范围 Today / Week / 7d / 30d，默认 Today。切换后周偏移归零。刷新按钮在加载时禁用。
17. 周步进（仅 Week）：前一周、后一周，到当前周时"后一周"禁用。
18. 主筛选 Model、Mode、Outcome，默认 Mode=stream、Outcome=success。Model 在手机上占两列。
19. 额外筛选放在可折叠区，显示已启用的数量；共 9 个字段。选项来自数据：Key 显示名称，unknown/hit/miss 显示翻译后的文字，已选但当前数据里没有的值仍然列出。
20. 多选控件：
    - 折叠时显示"全部"或已选项的列表；
    - 清除选择（无选择时禁用）；
    - 逐项勾选；
    - Esc 关闭后焦点回到触发按钮；点击外部关闭。
21. 状态：
    - 出错显示 `role=alert`；
    - 加载中显示 `role=status`，根元素带 `aria-busy`；
    - 加载完后显示"N requests"和均值说明；
    - 无请求时显示空状态；
    - 否则显示体验概览，有对比组时显示对比表；
    - 诊断区在加载完后始终显示。
22. 体验概览：3 行，每行有 h3、提示、均值（未知时变淡）、覆盖率；第 1、2 行有次指标。
23. 模型对比表：可滚动区域（`tabIndex=0`，带 aria-label），列不变。
24. 诊断：默认折叠；说明和 legacy 提示；14 行统计表，带 sr-only caption。

---

### Task 1: `src/ui` 第二批组件

**Files:**
- Create: `apps/dashboard/src/ui/page-header.tsx`、`card.tsx`、`segmented-control.tsx`、`select.tsx`、`multi-select.tsx`、`table.tsx`、`badge.tsx`、`empty-state.tsx`、`notice.tsx`
- Modify: `apps/dashboard/src/ui/dropdown-menu.tsx`（加入 CheckboxItem）、`apps/dashboard/src/styles.css`（全局输入框规则加入 `date`）
- Test: `apps/dashboard/src/ui/ui-batch2.test.tsx`

- [ ] **Step 1: 先看两个现有实现的行为**

  阅读 `apps/dashboard/src/components/MultiSelect.tsx`、`components/MultiSelect.test.tsx`，以及 `state/performance-data.ts` 中的 `togglePerformanceFilter`。新的多选必须保持同样的切换语义（顺序是否保留、是否排序），以及同样的摘要文字（无选择时显示 allLabel，否则把选项标签用 ", " 连起来；不在选项里的值显示原值）。

- [ ] **Step 2: 写失败的测试**

  `apps/dashboard/src/ui/ui-batch2.test.tsx`：

  ```tsx
  import { expect, test } from "bun:test"
  import { renderToStaticMarkup } from "react-dom/server"
  import { Badge } from "./badge"
  import { Card, SectionHeading } from "./card"
  import { EmptyState } from "./empty-state"
  import { MultiSelect, multiSelectSummary } from "./multi-select"
  import { Notice } from "./notice"
  import { PageHeader } from "./page-header"
  import { SegmentedControl } from "./segmented-control"
  import { Select, toRadixValue, fromRadixValue } from "./select"
  import { Table, Td, Th } from "./table"

  test("PageHeader renders the page title as the h1, with optional description and actions", () => {
    const html = renderToStaticMarkup(<PageHeader title="Usage" description="Tokens and cost" actions={<button type="button">R</button>} />)
    expect(html).toContain("<h1")
    expect(html).toContain(">Usage</h1>")
    expect(html).toContain("Tokens and cost")
    expect(html).toContain(">R</button>")
  })

  test("Card is a bordered section and SectionHeading an h2", () => {
    expect(renderToStaticMarkup(<Card>x</Card>)).toMatch(/^<section[^>]*border-border/)
    expect(renderToStaticMarkup(<SectionHeading>Model distribution</SectionHeading>)).toContain("<h2")
  })

  test("SegmentedControl is a labelled group whose current option is pressed", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl ariaLabel="Range" value="week" onChange={() => {}} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }]} />,
    )
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="Range"')
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1)
    expect(html).toMatch(/aria-pressed="true"[^>]*>Week</)
  })

  test("Select maps the empty 'all' value through a sentinel, since Radix forbids empty item values", () => {
    expect(fromRadixValue(toRadixValue(""))).toBe("")
    expect(toRadixValue("")).not.toBe("")
    expect(fromRadixValue(toRadixValue("gpt-6"))).toBe("gpt-6")
  })

  test("Select shows the current option's label and, with a visible label, is named by label and value", () => {
    const html = renderToStaticMarkup(
      <Select labelledBy="lbl" value="" onChange={() => {}} options={[{ value: "", label: "All keys" }, { value: "k1", label: "Key 1", badge: "shared" }]} />,
    )
    expect(html).toContain("All keys")
    expect(html).toMatch(/aria-labelledby="lbl [^"]+"/)
  })

  test("MultiSelect summarises the selection and keeps a stable accessible name", () => {
    const options = [{ value: "success", label: "Success" }, { value: "error", label: "Error" }]
    expect(multiSelectSummary([], options, "All")).toBe("All")
    expect(multiSelectSummary(["success", "error"], options, "All")).toBe("Success, Error")
    expect(multiSelectSummary(["gone"], options, "All")).toBe("gone")
    const html = renderToStaticMarkup(
      <MultiSelect ariaLabel="Outcome" value={["success"]} options={options} allLabel="All" clearLabel="Clear" onChange={() => {}} />,
    )
    expect(html).toContain('aria-label="Outcome"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain(">Success</span>")
  })

  test("Table cells: header cells are column headers, numeric cells align right", () => {
    const html = renderToStaticMarkup(<Table><thead><tr><Th>Model</Th><Th numeric>Cost</Th></tr></thead><tbody><tr><Td numeric>1</Td></tr></tbody></Table>)
    expect(html).toContain('scope="col"')
    expect(html).toMatch(/<td[^>]*text-right/)
  })

  test("Badge, EmptyState and Notice render their content with the right roles", () => {
    expect(renderToStaticMarkup(<Badge>shared</Badge>)).toContain(">shared</span>")
    expect(renderToStaticMarkup(<EmptyState title="No usage in range" />)).toContain("No usage in range")
    expect(renderToStaticMarkup(<Notice tone="danger">Boom</Notice>)).toContain('role="alert"')
    expect(renderToStaticMarkup(<Notice tone="info">Note</Notice>)).not.toContain('role="alert"')
  })
  ```

- [ ] **Step 3: 运行，确认失败**

  Run: `bun test apps/dashboard/src/ui/ui-batch2.test.tsx`
  Expected: FAIL（找不到模块）。

- [ ] **Step 4: 实现**

  `ui/page-header.tsx`：

  ```tsx
  import type { ReactNode } from "react"

  interface Props {
    title: string
    description?: ReactNode
    /** The page's own actions, e.g. refresh; right-aligned, wrapping under the title on narrow screens. */
    actions?: ReactNode
  }

  export function PageHeader({ title, description, actions }: Props) {
    return (
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
          {description ? <p className="mt-1 max-w-[65ch] text-[13px] leading-relaxed text-fg-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    )
  }
  ```

  `ui/card.tsx`：

  ```tsx
  import type { ComponentProps } from "react"
  import { cn } from "./cn"

  export function Card({ className, ...props }: ComponentProps<"section">) {
    return <section className={cn("rounded-lg border border-border bg-background p-4", className)} {...props} />
  }

  export function SectionHeading({ className, ...props }: ComponentProps<"h2">) {
    return <h2 className={cn("text-sm font-semibold text-fg", className)} {...props} />
  }
  ```

  `ui/segmented-control.tsx`：

  ```tsx
  import { cn } from "./cn"

  export interface SegmentedOption<T extends string> {
    value: T
    label: string
  }

  interface Props<T extends string> {
    options: ReadonlyArray<SegmentedOption<T>>
    value: T
    onChange: (value: T) => void
    ariaLabel: string
    size?: "sm" | "md"
    className?: string
  }

  /** A small set of mutually exclusive choices shown side by side. */
  export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, size = "md", className }: Props<T>) {
    return (
      <div role="group" aria-label={ariaLabel} className={cn("inline-flex items-center gap-0.5 rounded-md border border-control bg-panel p-0.5", className)}>
        {options.map((option) => {
          const active = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={cn(
                "whitespace-nowrap rounded-[5px] px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
                size === "sm" ? "h-6" : "h-7",
                active ? "bg-background text-fg shadow-xs" : "text-fg-muted hover:text-fg",
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    )
  }
  ```

  `ui/badge.tsx`：

  ```tsx
  import type { ReactNode } from "react"
  import { cn } from "./cn"

  const TONES = {
    neutral: "border-control bg-panel text-fg-muted",
    brand: "border-brand-text/30 bg-brand-text/10 text-brand-text",
    success: "border-success/30 bg-success/10 text-success",
    warn: "border-warn/30 bg-warn/10 text-warn",
    danger: "border-danger/30 bg-danger/10 text-danger",
  } as const

  export function Badge({ tone = "neutral", className, children }: { tone?: keyof typeof TONES; className?: string; children: ReactNode }) {
    return <span className={cn("inline-flex items-center rounded border px-1.5 text-xs leading-5", TONES[tone], className)}>{children}</span>
  }
  ```

  `ui/empty-state.tsx`：

  ```tsx
  import type { ReactNode } from "react"

  export function EmptyState({ title, description }: { title: string; description?: ReactNode }) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
        <p className="text-sm font-medium text-fg-muted">{title}</p>
        {description ? <p className="mt-1 text-[13px] text-fg-subtle">{description}</p> : null}
      </div>
    )
  }
  ```

  `ui/notice.tsx`：

  ```tsx
  import type { ReactNode } from "react"
  import { cn } from "./cn"

  const TONES = {
    info: "border-border bg-panel text-fg-muted",
    warn: "border-warn/30 bg-warn/10 text-warn",
    danger: "border-danger/30 bg-danger/10 text-danger",
  } as const

  /** An inline message. Danger notices are announced (role=alert); the others are not. */
  export function Notice({ tone = "info", className, children }: { tone?: keyof typeof TONES; className?: string; children: ReactNode }) {
    return (
      <div role={tone === "danger" ? "alert" : undefined} className={cn("rounded-md border px-3 py-2 text-[13px]", TONES[tone], className)}>
        {children}
      </div>
    )
  }
  ```

  `ui/table.tsx`：

  ```tsx
  import type { ComponentProps } from "react"
  import { cn } from "./cn"

  /** A table in a horizontally scrollable frame. */
  export function Table({ className, ...props }: ComponentProps<"table">) {
    return (
      <div className="min-w-0 overflow-x-auto">
        <table className={cn("w-full border-collapse text-[13px]", className)} {...props} />
      </div>
    )
  }

  export function Th({ className, numeric = false, ...props }: ComponentProps<"th"> & { numeric?: boolean }) {
    return (
      <th
        scope="col"
        className={cn("h-9 border-b border-border px-3 text-xs font-medium text-fg-muted", numeric ? "text-right" : "text-left", className)}
        {...props}
      />
    )
  }

  export function Td({ className, numeric = false, ...props }: ComponentProps<"td"> & { numeric?: boolean }) {
    return <td className={cn("border-b border-border px-3 py-2 text-fg", numeric && "text-right font-mono tabular-nums", className)} {...props} />
  }
  ```

  `ui/select.tsx`：

  ```tsx
  import * as RadixSelect from "@radix-ui/react-select"
  import { Check, ChevronDown } from "lucide-react"
  import { useId } from "react"
  import { Badge } from "./badge"
  import { cn } from "./cn"

  export interface SelectOption {
    value: string
    label: string
    /** A pill after the label, e.g. "shared" on a shared API key. */
    badge?: string
  }

  // Radix reserves the empty string for "no value", but our filters use "" for "all".
  const EMPTY = "\u0000all"
  export const toRadixValue = (value: string) => (value === "" ? EMPTY : value)
  export const fromRadixValue = (value: string) => (value === EMPTY ? "" : value)

  interface Props {
    value: string
    options: SelectOption[]
    onChange: (value: string) => void
    /** Id of a visible label. The trigger is then named "label + current value", matching what is shown. */
    labelledBy?: string
    /** Used only when there is no visible label. */
    ariaLabel?: string
    placeholder?: string
    disabled?: boolean
    size?: "sm" | "md"
    className?: string
  }

  export function Select({ value, options, onChange, labelledBy, ariaLabel, placeholder, disabled = false, size = "md", className }: Props) {
    const valueId = useId()
    const current = options.find((o) => o.value === value)
    return (
      <RadixSelect.Root value={toRadixValue(value)} onValueChange={(v) => onChange(fromRadixValue(v))} disabled={disabled}>
        <RadixSelect.Trigger
          aria-labelledby={labelledBy ? `${labelledBy} ${valueId}` : undefined}
          aria-label={labelledBy ? undefined : ariaLabel}
          className={cn(
            "inline-flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left text-[13px] text-fg transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text disabled:cursor-not-allowed disabled:opacity-50",
            size === "sm" ? "h-7" : "h-8",
            className,
          )}
        >
          <span id={valueId} className="flex min-w-0 items-center gap-1.5">
            <span className={cn("truncate", !current && "text-fg-subtle")}>{current?.label ?? placeholder ?? ""}</span>
            {current?.badge ? <Badge>{current.badge}</Badge> : null}
          </span>
          <ChevronDown className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={4}
            collisionPadding={8}
            className="z-50 max-h-[min(var(--radix-select-content-available-height),20rem)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-background text-fg shadow-lg"
          >
            <RadixSelect.Viewport className="p-1">
              {options.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={toRadixValue(option.value)}
                  className="relative flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-7 pr-2 text-[13px] text-fg-muted outline-none data-[highlighted]:bg-muted data-[highlighted]:text-fg data-[state=checked]:text-fg"
                >
                  <RadixSelect.ItemIndicator className="absolute left-2 inline-flex">
                    <Check className="size-3.5" aria-hidden="true" />
                  </RadixSelect.ItemIndicator>
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  {option.badge ? <Badge>{option.badge}</Badge> : null}
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    )
  }
  ```

  在 `ui/dropdown-menu.tsx` 中，`DropdownMenuItem` 之后加入：

  ```tsx
  export function DropdownMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof Menu.CheckboxItem>) {
    return (
      <Menu.CheckboxItem
        className={cn(
          "relative flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-7 pr-2 text-[13px] text-fg-muted outline-none data-[highlighted]:bg-muted data-[highlighted]:text-fg data-[state=checked]:text-fg data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
          className,
        )}
        {...props}
      >
        <Menu.ItemIndicator className="absolute left-2 inline-flex">
          <Check className="size-3.5" aria-hidden="true" />
        </Menu.ItemIndicator>
        {children}
      </Menu.CheckboxItem>
    )
  }
  ```

  并在该文件顶部加入 `import { Check } from "lucide-react"`。

  `ui/multi-select.tsx`（`toggle` 的语义以 Step 1 读到的 `togglePerformanceFilter` 为准；如果原函数会排序或保持选项顺序，这里照做，并加一条测试固定它）：

  ```tsx
  import { ChevronDown } from "lucide-react"
  import { useId } from "react"
  import { cn } from "./cn"
  import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from "./dropdown-menu"

  export interface MultiSelectOption {
    value: string
    label: string
  }

  export function multiSelectSummary(value: string[], options: MultiSelectOption[], allLabel: string): string {
    if (value.length === 0) return allLabel
    const labels = new Map(options.map((o) => [o.value, o.label]))
    return value.map((v) => labels.get(v) ?? v).join(", ")
  }

  function toggle(value: string[], item: string): string[] {
    return value.includes(item) ? value.filter((v) => v !== item) : [...value, item]
  }

  interface Props {
    value: string[]
    options: MultiSelectOption[]
    onChange: (value: string[]) => void
    allLabel: string
    clearLabel: string
    ariaLabel: string
    className?: string
  }

  /** Pick any number of values; an empty selection means "all". The menu stays open while ticking. */
  export function MultiSelect({ value, options, onChange, allLabel, clearLabel, ariaLabel, className }: Props) {
    const summaryId = useId()
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={ariaLabel}
          aria-describedby={summaryId}
          className={cn(
            "inline-flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left text-[13px] text-fg transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
            className,
          )}
        >
          <span id={summaryId} className="truncate min-w-0">{multiSelectSummary(value, options, allLabel)}</span>
          <ChevronDown className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto">
          <DropdownMenuItem disabled={value.length === 0} onSelect={(e) => { e.preventDefault(); onChange([]) }}>
            {clearLabel}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {options.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={value.includes(option.value)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => onChange(toggle(value, option.value))}
            >
              {option.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  ```

  最后，在 `styles.css` 的全局输入框规则（`input[type="text"], …, input[type="url"]`）里加入 `input[type="date"]`，让日期输入框和其他输入框一致。

- [ ] **Step 5: 运行，确认通过**

  Run: `bun test apps/dashboard/src/ui && (cd apps/dashboard && bun run typecheck)`
  Expected: 全部通过；类型检查无报错。

  如果 `MultiSelect` 静态渲染出的 summary span 不是 `>Success</span>`（例如 Radix 在 span 外又包了一层），就按实际 HTML 调整断言，但必须仍能证明：可访问名称是 `ariaLabel`、`aria-expanded="false"`，并且摘要文字可见。

---

### Task 2: 延迟页迁移

**Files:**
- Modify: `apps/dashboard/src/tabs/latency/LatencyTab.tsx`、`ExperienceSummary.tsx`、`ModelComparison.tsx`、`PerformanceDiagnostics.tsx`
- Delete: `apps/dashboard/src/components/MultiSelect.tsx`、`components/MultiSelect.test.tsx`（前提是 Task 1 的多选测试已覆盖原测试的断言）

- [ ] **Step 1:** 按映射规则改写四个文件：
  - `LatencyTab` 顶部改为 `<PageHeader title={t("dash.perf.experience.title")} description={t("dash.perf.experience.scope")} actions={…} />`。actions 依次放：
    - 范围 `SegmentedControl`，aria-label 用 `t("dash.perf.range")`。这个键不存在，需要在中英文字典新增：en "Time range"，zh "时间范围"；
    - 刷新按钮 `<Button variant="secondary" size="sm">`，文案不变，加载时禁用。
  - 周步进改用 ChevronLeft/ChevronRight 图标按钮，保留 aria-label 和禁用条件。
  - 筛选改用 `ui/multi-select`。字段标签保留现有 `id`，并把这个 id 传给 `labelledBy`（不再传 `ariaLabel`）；摘要逻辑和选项与原来一致。
  - 额外筛选的 `<details>` 保留原生元素：`summary` 加 `ChevronRight` 图标，展开时旋转 90°（`group-open:rotate-90`，需在 details 上加 `group`），计数保留。
  - 错误改用 `<Notice tone="danger">`；加载占位保留 `role=status`，样式改为 `rounded-lg border border-border bg-panel`；无请求时用 `<EmptyState title={t("dash.perf.empty")} />`。
  - `ExperienceSummary`、`ModelComparison`、`PerformanceDiagnostics`：外层改用 `<Card>`；页面标题是 h1，各区块标题改为 h2（`<SectionHeading>`，例如模型对比表的标题）；没有可见区块标题的区块（如体验概览）在 Card 前加 `<h2 className="sr-only">`；原有的 h3 只有在上方已有 h2 时才保持 h3；表格改用 `<Table label=…>`、`Th`、`Td`：原可滚动区域的 aria-label 文案传给 `label`，由 `Table` 渲染带 `tabIndex=0` 的 region，删除页面自己的滚动包裹层；保留 sr-only caption、`n=` 与 `→`；诊断区的 `<details>` 同样加旋转图标。
- [ ] **Step 2:** 删除旧的 `components/MultiSelect.tsx` 及其测试，然后 `grep -rn "components/MultiSelect" apps/dashboard/src`，应无输出。
- [ ] **Step 3:** 运行 `bun test apps/dashboard packages/gateway/tests/i18n-keys.test.ts`、类型检查和 lint（只看本次改动的文件），全部通过。
- [ ] **Step 4:** 对照功能清单第 15–24 项自查代码：每一项都要能指出新代码中对应的位置，写进任务报告。

---

### Task 3: 用量页·页头、工具栏、周期和 28 天控件

**Files:**
- Modify: `apps/dashboard/src/tabs/usage/UsageTab.tsx`（`FilterHint` 之外的部分）、`apps/dashboard/src/tabs/usage/UsageRefresh.tsx`

- [ ] **Step 1:** `UsageTab`：
  - 去掉外层 `glass-card` 和 "USAGE" 标签，改为 `<PageHeader title={t("dash.usage")} actions={<UsageRefresh … />} />`。
  - 下面是工具栏：指标、范围、时区三个 `SegmentedControl`，aria-label 依次为：
    - `t("dash.usage.metricLabel")`：en "Metric"，zh "指标"；
    - `t("dash.usage.rangeLabel")`：en "Time range"，zh "时间范围"；
    - `t("dash.usage.timeZoneLabel")`：en "Time zone"，zh "时区"。

    这三个键需新增到两份字典。
  - 周期步进改用图标按钮。原来的 `title` 保留，并补上同样内容的 `aria-label`。
  - 28 天控件：
    - 原生日期输入框；删除 `focus:border-surface-600!`；
    - "Latest window" 改为 `<Button variant="ghost" size="sm">`；
    - 滚动区开关改为 `<Button variant="ghost" size="sm" aria-expanded=…>`，箭头换成 ChevronDown/ChevronUp。
  - 图表区（说明文字、routed/incoming 切换、`TimeSeriesChart`、时区脚注）和汇总放进一个 `<Card>`。
  - "MODEL DISTRIBUTION" 改用 `<SectionHeading>`，旁边的切换改用 `SegmentedControl`。
  - "No usage in range" 改用 `<EmptyState>`。
  - 删除文件内的 `SegmentedGroup`。
- [ ] **Step 2:** `UsageRefresh`：
  - 刷新按钮改为 `<Button variant="secondary" size="icon">`，内放 `RefreshCw` 图标（加载时 `animate-spin`），用 `ui/tooltip` 显示原来的 `dash.usage.refreshTip`，aria-label 保持不变。删除 `data-tip` 和 `hover:text-accent-violet!`。
  - 自动刷新下拉改用 `ui/select`（`size="sm"`）。它原来没有标签，现在给它 `ariaLabel={t("dash.usage.autoRefreshLabel")}`，新增键：en "Auto refresh"，zh "自动刷新"。开启时的高亮改为 `border-brand-text text-brand-text`。
  - "N 分钟前"改为 `text-xs text-fg-subtle`。
- [ ] **Step 3:** 运行测试、类型检查和 lint，全部通过；对照功能清单第 1–6、13 项自查并写进报告。

---

### Task 4: 用量页·筛选

**Files:**
- Modify: `apps/dashboard/src/tabs/usage/UsageFilters.tsx`、`apps/dashboard/src/tabs/usage/UsageTab.tsx`（仅 `FilterHint`）

- [ ] **Step 1:** 五个筛选都改用 `ui/select`：
  - 每个字段的可见标签用 `<span id=…>`（用 `useId` 生成），通过 `labelledBy` 关联到 Select，修掉 Lighthouse 报的"可见文字与可访问名称不一致"。
  - 原来传 `ariaLabel` 的两个（routed、incoming）也改用 `labelledBy`。
  - 共享 Key 的徽章通过 `badge` 显示。
  - 选项值和编码不变（`""` 表示全部，传入模型用 `model:` 前缀），由 `ui/select` 内部处理空值。
- [ ] **Step 2:** 字段标签按映射规则改为 `text-xs font-medium text-fg-muted`，不再大写；共享用量说明改用 `<Notice tone="info">`；"Clear filters" 改为 `<Button variant="ghost" size="sm">`；`FilterHint` 的字号改为 `text-xs text-fg-subtle`。
- [ ] **Step 3:** 运行测试、类型检查和 lint；对照功能清单第 9、14 项自查并写进报告。

---

### Task 5: 用量页·汇总、分布表、滚动条带、预测

**Files:**
- Modify: `apps/dashboard/src/tabs/usage/UsageSummary.tsx`、`UsageDistributionTable.tsx`、`RollingStrip.tsx`、`UsageForecast.tsx`

- [ ] **Step 1:** `UsageSummary`：
  - 格子之间的边框改为 `border-border`；Cache read 的数值颜色改为 `text-success`。
  - Total tokens 的信息图标改为 `<button type="button" aria-label=…>` 内放 lucide `Info` 图标，用 `ui/tooltip`（`side="bottom"`）显示原来的加权 tokens 浮层，浮层内容和计算不变。这样修掉 Lighthouse 报的"aria-label 用在无 role 元素上"。
  - 字号按映射规则统一。
- [ ] **Step 2:** `UsageDistributionTable`：
  - 外层改用 `<Card>`，标题改用 `<SectionHeading>`；表格改用 `Table`、`Th`、`Td`（数字列用 `numeric`）；保留 `aria-label`。
  - 占比条、联动高亮、读数行、各段的 `title` 和数据驱动的行内样式都不变；字号统一。
- [ ] **Step 3:** `RollingStrip`：
  - 标题和提示按映射规则改写；浮层改为 `rounded-md border border-border bg-background shadow-lg text-xs`；图例字号统一。
  - 选中环 `ring-white/70` 改为 `ring-fg`，预测高亮环 `ring-amber-400` 改为 `ring-warn`，悬停环改为 `hover:ring-fg-subtle`。
  - 色阶数组和点击、聚焦行为不变；方格的 aria-label 不变。
- [ ] **Step 4:** `UsageForecast`：
  - 标题改用 `<SectionHeading>`；预算输入框删除 `focus:border-surface-600!`；
  - 行的悬停、聚焦边框改为 `hover:border-warn/60 focus:border-warn/60`；超支金额改为 `text-danger`；字号统一。
- [ ] **Step 5:** 运行测试、类型检查和 lint；对照功能清单第 7、8、11、12 项自查并写进报告。

---

### Task 6: 图表字体与提示框

**Files:**
- Modify: `apps/dashboard/src/components/TimeSeriesChart.tsx`、`apps/dashboard/src/styles.css`（`.pg-chart-tip*` 部分）
- Test: `apps/dashboard/src/components/TimeSeriesChart.test.ts`

- [ ] **Step 1: 写失败的测试。** 在 `TimeSeriesChart.test.ts` 中加入：

  ```ts
  describe("chartFont", () => {
    test("reads the family from the CSS variable and falls back when it is missing", async () => {
      const { chartFont } = await import("./TimeSeriesChart")
      expect(chartFont((name) => (name === "--font-sans" ? ' "Geist", sans-serif ' : ""), "sans")).toBe('"Geist", sans-serif')
      expect(chartFont(() => "", "mono")).toBe("ui-monospace, monospace")
      expect(chartFont(() => "", "sans")).toBe("ui-sans-serif, system-ui, sans-serif")
    })
  })
  ```

- [ ] **Step 2:** 实现并导出：

  ```ts
  /** The chart's font family, taken from the page's --font-sans / --font-mono so it follows the design system. */
  export function chartFont(read: (name: string) => string, kind: "sans" | "mono"): string {
    const value = read(kind === "sans" ? "--font-sans" : "--font-mono").trim()
    if (value) return value
    return kind === "sans" ? "ui-sans-serif, system-ui, sans-serif" : "ui-monospace, monospace"
  }
  ```

  然后在创建图表的位置：
  - 用 `const css = getComputedStyle(document.documentElement); const read = (n: string) => css.getPropertyValue(n)` 取字体，替换三处写死的字体名。
  - 刻度和图例字号统一为 12。
  - 图表创建后，在 `document.fonts?.ready.then(() => chart.update())` 中重绘一次，组件卸载时不再调用（判断 chart 是否已销毁）。
- [ ] **Step 3:** 在 `styles.css` 的 `.pg-chart-tip*` 中：`font-size: 11px` 改为 `12px`；阴影改为 `var(--shadow-lg)` 或保持现值但颜色用 `color-mix(in oklab, black 20%, transparent)`；边框用 `var(--border-color)`，背景用 `var(--surface-900)`，文字用 `var(--text-primary)`。只改颜色、字号和阴影，不改布局。
- [ ] **Step 4:** 运行测试、类型检查和构建，全部通过。

---

### Task 7: 浏览器验证与全量检查

**Files:** 无代码改动（发现问题时回到对应任务修正）。

- [ ] **Step 1: 预览环境。** 参照第一期计划（`docs/superpowers/plans/2026-11-11-dashboard-redesign-phase1.md`）附录 A，在本 worktree 起临时网关。注意以下几点：
  - 网关路径改为本 worktree 的 `apps/platform-bun/src/server.ts`；
  - 截图前缀用 `p2o-`；
  - 本地数据较少，可以按第一期 Task 7 的做法，往数据库副本里写入合成用量：2 个用户、8 个模型、带缓存，覆盖本月前 10 天；再加一条 9 月、`incoming_model` 为空的记录。合成数据只写进副本。
- [ ] **Step 2: 逐项验证功能清单第 1–24 项。**
  - 每项记录"通过 / 不通过"，附截图路径或操作说明。
  - 用量页在管理员和普通用户下各看一遍；两页在浅色和深色、中文和英文下各看一遍；宽度 1440 和 390 各看一遍。
  - 键盘检查：
    - Select：Enter 或空格打开，方向键选择，Esc 关闭后焦点回到触发按钮；
    - MultiSelect：勾选时菜单不关闭；
    - 分段切换：能用 Tab 和 Enter 操作；
    - 信息按钮：聚焦时显示浮层。
- [ ] **Step 3:** 对两页跑 Lighthouse 无障碍审计，记录分数。用量页上一期遗留的两项（信息图标、筛选下拉的名称）应已消失。
- [ ] **Step 4: 体积。** 与第一期（js 1,040,222 字节，gzip 326,210 字节）对比，记录增量；如果超过 100 KB，查明原因。
- [ ] **Step 5: 清理预览环境，跑全量检查**：`bun run build:setup`；全量 `bun test` 放后台运行；同时跑 typecheck、lint、build:ui 和 deploy:dry。已知无关失败：`reference-adapter.test.ts`。
- [ ] **Step 6: 交付。** 向主控报告：每项验证结果、Lighthouse 分数、体积、修正项，以及第二期待办里本组已完成和新发现的条目。不要提交。
