# Usage 趋势图按模型分线 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理员选定一个人（或普通用户查看自己）时，Usage 趋势图每个模型一条线；请求模型为空的旧记录按其实际模型显示，不再出现"Legacy"。

**Architecture:** 只改前端 `apps/dashboard`。分线逻辑从 `state/usage.ts` 的内联代码抽成纯函数 `state/usage-chart.ts`；请求模型的空值在接口适配层 `api/usage.ts` 统一回退为实际模型；`TimeSeriesChart` 增加向后兼容的可选参数（初始隐藏、缓存说明、提示框排序、记住图例选择）。

**Tech Stack:** React 19、Chart.js 4、Bun test、Tailwind；文案在 `packages/gateway/src/shared/edge/ui-pages/i18n.ts`。

**Spec:** `docs/superpowers/specs/2026-11-10-usage-per-model-chart-design.md`

**约定：**
- 路径都相对 `vnext/`。测试从 `vnext/` 运行：`bun test <path>`。
- 界面叫法：路由模型（routed，实际模型）、传入模型（incoming，请求模型）。
- 按用户的要求，**只在用户确认后才提交和推送**；各任务末尾不单独提交，统一在 Task 7 结束后询问。

## 文件结构

| 文件 | 职责 | 改动 |
|---|---|---|
| `apps/dashboard/src/api/usage.ts` | 接口行适配 | 空请求模型回退为实际模型 |
| `apps/dashboard/src/api/usage.test.ts` | 适配测试 | 更新旧行为断言 |
| `apps/dashboard/src/state/usage-model-dimensions.ts` | 模型筛选与分布 | 删除 Legacy 选项和分支 |
| `apps/dashboard/src/state/usage-model-dimensions.test.ts` | 同上测试 | 更新 |
| `apps/dashboard/src/state/usage-chart.ts` | **新**：趋势图分组与分线 | 纯函数 |
| `apps/dashboard/src/state/usage-chart.test.ts` | **新**：上述测试 | |
| `apps/dashboard/src/state/usage.ts` | Usage 状态 | 改用新纯函数；上移模型种类状态 |
| `apps/dashboard/src/components/TimeSeriesChart.tsx` | 折线图 | 新可选参数 |
| `apps/dashboard/src/components/tooltip-text.test.ts` | **新**：提示框文本测试 | |
| `apps/dashboard/src/tabs/usage/UsageFilters.tsx` | 筛选栏 | 去掉 Legacy 选项 |
| `apps/dashboard/src/tabs/usage/UsageTab.tsx` | Usage 页 | 接入按模型分线、说明行和切换 |
| `packages/gateway/src/shared/edge/ui-pages/i18n.ts` | 文案 | 新增 4 个键，删除 2 个 Legacy 键 |

---

### Task 1: 请求模型为空时回退为实际模型

**Files:**
- Modify: `apps/dashboard/src/api/usage.ts`（`adaptUsageRow` 中的 `incomingModel` 一行）
- Test: `apps/dashboard/src/api/usage.test.ts`

- [ ] **Step 1: 改写测试**

把 `apps/dashboard/src/api/usage.test.ts` 中第一个测试替换为下面两个（第二个原有测试 "preserves an incoming model emitted by a newer server" 保留不动）：

```ts
// Records from before 2026-09-06 carry no incoming model. Key model mappings
// did not exist yet, so the model asked for was the model served.
test("falls back to the routed model when a record has no incoming model", () => {
  const oldServerRow: ServerUsageRow = {
    hour: "2026-09-04T12",
    keyId: "key-a",
    model: "target-model",
    requests: 1,
  }
  expect(adaptUsageRow(oldServerRow).incomingModel).toBe("target-model")
  expect(adaptUsageRow({ ...oldServerRow, incomingModel: "" }).incomingModel).toBe("target-model")
})

test("leaves the incoming model empty only when no model was recorded at all", () => {
  expect(adaptUsageRow({ hour: "2026-09-04T12", keyId: "key-a", requests: 1 }).incomingModel).toBe("")
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test apps/dashboard/src/api/usage.test.ts`
Expected: FAIL，`Expected: "target-model"`，`Received: ""`。

- [ ] **Step 3: 实现**

`apps/dashboard/src/api/usage.ts` 的 `adaptUsageRow` 中，把

```ts
    incomingModel: r.incomingModel ?? "",
```

改为

```ts
    // Empty only on records from before the column existed, when key model
    // mappings did not exist either: the model asked for was the one served.
    incomingModel: r.incomingModel || r.model || "",
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test apps/dashboard/src/api/usage.test.ts`
Expected: PASS（3 pass）。

---

### Task 2: 去掉 Legacy 选项和分支

**Files:**
- Modify: `apps/dashboard/src/state/usage-model-dimensions.ts`
- Modify: `apps/dashboard/src/state/usage.ts:430`
- Modify: `apps/dashboard/src/tabs/usage/UsageFilters.tsx:75-78`
- Modify: `apps/dashboard/src/tabs/usage/UsageTab.tsx:359`
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts`（删除 `dash.legacy`、`dash.legacyUnknown` 中英各一行）
- Test: `apps/dashboard/src/state/usage-model-dimensions.test.ts`

- [ ] **Step 1: 改写测试**

在 `apps/dashboard/src/state/usage-model-dimensions.test.ts` 中：

1. `round trips arbitrary JavaScript strings…` 测试里，把 `expect(decodeIncomingModelOption("legacy")).toBe("")` 改为：

```ts
    expect(decodeIncomingModelOption("legacy")).toBeNull()
```

2. `maps incoming filter state…` 测试里，把 `expect(incomingModelFilterValue("")).toBe("legacy")` 改为：

```ts
    expect(incomingModelFilterValue("")).toBe("model:")
```

3. 把整个 `lists legacy once and omits its duplicate encoded model option` 测试替换为：

```ts
  test("lists each incoming model once, with no legacy option", () => {
    expect(incomingModelSelectOptions(["caller-b", "", "caller-a", "caller-a"], { all: "All" })).toEqual([
      { value: "all", label: "All" },
      { value: "model:caller-a", label: "caller-a" },
      { value: "model:caller-b", label: "caller-b" },
    ])
  })
```

4. 把 `selects legacy unknown incoming model only` 的测试名改为 `matches an empty incoming model exactly`（断言不变）。

5. 把 `keeps legacy and a real matching label in separate incoming groups` 整个替换为：

```ts
  test("keeps an unrecorded model and a real model named like the fallback apart", () => {
    const distribution = buildIncomingModelDistribution([
      row({ incomingModel: "", model: "target", requests: 2 }),
      row({ incomingModel: "Unknown", model: "named-target", requests: 3 }),
    ], "Unknown")

    expect(distribution).toMatchObject([
      { label: "Unknown", requests: 2, routedModels: ["target"] },
      { label: "Unknown", requests: 3, routedModels: ["named-target"] },
    ])
    expect(new Set(distribution.map((value) => value.id)).size).toBe(2)
  })
```

6. `incoming distribution preserves legacy rows and lists each routed model once`：测试名改为 `incoming distribution lists each routed model once`，调用改为 `buildIncomingModelDistribution(rows, "Unknown")`，期望中的 `label: "Legacy / Unknown"` 改为 `label: "Unknown"`。

7. `distribution totals and summary conserve every metric` 中的 `buildIncomingModelDistribution(rows, "Legacy / Unknown", "Unknown")` 改为 `buildIncomingModelDistribution(rows, "Unknown")`。

- [ ] **Step 2: 运行，确认失败**

Run: `bun test apps/dashboard/src/state/usage-model-dimensions.test.ts`
Expected: FAIL（`decodeIncomingModelOption("legacy")` 仍返回 `""`、选项列表仍含 legacy 等）。

- [ ] **Step 3: 实现 `usage-model-dimensions.ts`**

把文件开头到 `incomingModelSelectOptions` 结束（原第 1–35 行）替换为：

```ts
import type { UsageRow } from "../api/usage"
import { rowMatchesUser, type ParticipantIndex } from "../tabs/usage/participants"

export const ALL_INCOMING_MODEL_OPTION = "all"
const INCOMING_MODEL_VALUE_PREFIX = "model:"

export function incomingModelOptionValue(model: string): string {
  return `${INCOMING_MODEL_VALUE_PREFIX}${model}`
}

export function incomingModelFilterValue(model: string | null): string {
  return model === null ? ALL_INCOMING_MODEL_OPTION : incomingModelOptionValue(model)
}

export function decodeIncomingModelOption(value: string): string | null {
  return value.startsWith(INCOMING_MODEL_VALUE_PREFIX)
    ? value.slice(INCOMING_MODEL_VALUE_PREFIX.length)
    : null
}

export function incomingModelSelectOptions(
  models: readonly string[],
  labels: { all: string },
): Array<{ value: string; label: string }> {
  return [
    { value: ALL_INCOMING_MODEL_OPTION, label: labels.all },
    ...[...new Set(models)].filter((model) => model !== "").sort().map((model) => ({ value: incomingModelOptionValue(model), label: model })),
  ]
}
```

`UsageModelFilters` 中 `incomingModel` 的注释改为：

```ts
  /** null is all incoming models. */
  incomingModel: string | null
```

`ModelDistributionRow.id` 的注释改为：

```ts
  /** Stable identity; can differ from label when a real model matches the unknown label. */
  id: string
```

把文件末尾的 `buildIncomingModelDistribution` 替换为：

```ts
export function buildIncomingModelDistribution(
  rows: UsageRow[],
  unknownLabel: string,
): ModelDistributionRow[] {
  return distributeBy(
    rows,
    (row) => row.incomingModel,
    // Empty only when no model was recorded at all (see adaptUsageRow).
    (row, key) => key === "" ? unknownLabel : row.incomingModel,
    true,
    unknownLabel,
  )
}
```

- [ ] **Step 4: 更新调用方**

`apps/dashboard/src/state/usage.ts` 中：

```ts
        ? buildIncomingModelDistribution(filtered, t("dash.legacyUnknown"), t("dash.unknown"))
```

改为

```ts
        ? buildIncomingModelDistribution(filtered, t("dash.unknown"))
```

同文件 `UsageFilters` 接口的注释 `/** null is all incoming models; an empty string is a legacy record. */` 改为 `/** null is all incoming models. */`；`DistributionRow.id` 的注释 `Stable identity, distinct from the display label for legacy-name collisions.` 改为 `Stable identity, distinct from the display label when names collide.`。

`apps/dashboard/src/tabs/usage/UsageFilters.tsx` 中：

```tsx
          options={incomingModelSelectOptions(dimensions.incomingModels, {
            all: t("dash.all"),
            legacy: t("dash.legacy"),
          })}
```

改为

```tsx
          options={incomingModelSelectOptions(dimensions.incomingModels, { all: t("dash.all") })}
```

`apps/dashboard/src/tabs/usage/UsageTab.tsx` 的 `FilterHint` 中：

```tsx
    selected.push(t("dash.filterIncomingModel", { value: filters.incomingModel || t("dash.legacyUnknown") }))
```

改为

```tsx
    selected.push(t("dash.filterIncomingModel", { value: filters.incomingModel || t("dash.unknown") }))
```

- [ ] **Step 5: 删除不再使用的文案**

```bash
grep -rn 'dash\.legacy"\|dash\.legacyUnknown"' apps/dashboard/src
```

Expected: 无输出。然后在 `packages/gateway/src/shared/edge/ui-pages/i18n.ts` 中删除这四行（英文两行、中文两行）：

```
      "dash.legacy": "Legacy",
      "dash.legacyUnknown": "Legacy / Unknown",
      "dash.legacy": "旧版",
      "dash.legacyUnknown": "旧数据／未知",
```

```bash
python3 - <<'EOF'
p='packages/gateway/src/shared/edge/ui-pages/i18n.ts'
s=open(p).read()
for line in ['      "dash.legacy": "Legacy",\n','      "dash.legacyUnknown": "Legacy / Unknown",\n','      "dash.legacy": "旧版",\n','      "dash.legacyUnknown": "旧数据／未知",\n']:
    assert s.count(line)==1, line
    s=s.replace(line,'')
open(p,'w').write(s)
EOF
```

- [ ] **Step 6: 运行，确认通过**

Run: `bun test apps/dashboard/src/state/usage-model-dimensions.test.ts apps/dashboard/src/api/usage.test.ts packages/gateway/tests/i18n-keys.test.ts`
Expected: 全部 PASS。

Run: `cd apps/dashboard && bun run typecheck`
Expected: 无错误输出。

---

### Task 3: 趋势图分组与分线的纯函数

**Files:**
- Create: `apps/dashboard/src/state/usage-chart.ts`
- Test: `apps/dashboard/src/state/usage-chart.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `apps/dashboard/src/state/usage-chart.test.ts`：

```ts
import { describe, expect, test } from "bun:test"
import type { UsageRow } from "../api/usage"
import { buildUsageChartSeries, chartGrouping, DEFAULT_VISIBLE_MODELS, type UsageChartInput } from "./usage-chart"

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    hour: "2026-11-10T01",
    keyId: "key-a",
    incomingModel: "alias",
    model: "model-a",
    client: "client-a",
    requests: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheCreationTokens: 3,
    cost: { totalUSD: 0.5 },
    ...overrides,
  }
}

function input(rows: UsageRow[], overrides: Partial<UsageChartInput> = {}): UsageChartInput {
  return {
    rows,
    bucketKeys: ["2026-11-10T01", "2026-11-10T02"],
    bucketOf: (r) => r.hour,
    grouping: "model",
    modelKind: "routed",
    metric: "tokens",
    person: (r) => ({ id: `user:${r.keyId}`, label: r.keyId }),
    unknownLabel: "Unknown",
    ...overrides,
  }
}

describe("chartGrouping", () => {
  test("splits by person until an admin picks one, then by model", () => {
    expect(chartGrouping(true, "")).toBe("user")
    expect(chartGrouping(true, "user-a")).toBe("model")
  })

  test("a non-admin, who only ever sees their own usage, gets models", () => {
    expect(chartGrouping(false, "")).toBe("model")
  })
})

describe("buildUsageChartSeries", () => {
  test("one line per routed model, each bucket carrying value, cost and cache", () => {
    const lines = buildUsageChartSeries(input([
      row(),
      row({ hour: "2026-11-10T02", model: "model-b", cost: { totalUSD: 0.25 } }),
      row({ hour: "2026-11-10T02" }),
    ]))
    // 10 input + 5 output + 5 cache = 20 tokens per row.
    expect(lines).toEqual([
      { id: "model:model-a", label: "model-a", data: [20, 20], cost: [0.5, 0.5], cache: [5, 5], hidden: false },
      { id: "model:model-b", label: "model-b", data: [0, 20], cost: [0, 0.25], cache: [0, 5], hidden: false },
    ])
  })

  test("the incoming kind splits by the model the caller asked for", () => {
    const lines = buildUsageChartSeries(input([
      row({ incomingModel: "alias-x" }),
      row({ incomingModel: "alias-y" }),
    ], { modelKind: "incoming" }))
    expect(lines.map((l) => l.label).sort()).toEqual(["alias-x", "alias-y"])
  })

  test("a row with no model recorded is drawn under the unknown label", () => {
    const lines = buildUsageChartSeries(input([row({ model: undefined })]))
    expect(lines.map((l) => [l.id, l.label])).toEqual([["missing:", "Unknown"]])
  })

  test("models are ordered by total, and only the busiest few are shown at first", () => {
    const rows = Array.from({ length: DEFAULT_VISIBLE_MODELS + 2 }, (_, i) =>
      row({ model: `m${i}`, inputTokens: 10 * (i + 1), outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }))
    const lines = buildUsageChartSeries(input(rows))
    expect(lines.map((l) => l.label)).toEqual(["m7", "m6", "m5", "m4", "m3", "m2", "m1", "m0"])
    expect(lines.map((l) => l.hidden)).toEqual([false, false, false, false, false, false, true, true])
  })

  test("ties are broken by name so the order is stable", () => {
    const lines = buildUsageChartSeries(input([row({ model: "zeta" }), row({ model: "alpha" })]))
    expect(lines.map((l) => l.label)).toEqual(["alpha", "zeta"])
  })

  test("the requests metric counts requests and carries no cache", () => {
    const [line] = buildUsageChartSeries(input([row({ requests: 3 })], { metric: "requests" }))
    expect(line).toMatchObject({ data: [3, 0], cache: [0, 0], cost: [0.5, 0] })
  })

  test("per-person lines keep their first-seen order and all start visible", () => {
    const lines = buildUsageChartSeries(input([
      row({ keyId: "key-b" }),
      row({ keyId: "key-a", inputTokens: 1000 }),
    ], { grouping: "user" }))
    expect(lines).toEqual([
      { id: "user:key-b", label: "key-b", data: [20, 0], cost: [0.5, 0], cache: [5, 0], hidden: false },
      { id: "user:key-a", label: "key-a", data: [1010, 0], cost: [0.5, 0], cache: [5, 0], hidden: false },
    ])
  })

  test("rows outside the drawn buckets are ignored", () => {
    expect(buildUsageChartSeries(input([row({ hour: "2026-11-09T23" })]))).toEqual([])
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test apps/dashboard/src/state/usage-chart.test.ts`
Expected: FAIL，`Cannot find module './usage-chart'`。

- [ ] **Step 3: 实现**

创建 `apps/dashboard/src/state/usage-chart.ts`：

```ts
// The Usage trend chart's lines: who or what each one stands for, and the
// value, cost and cache it carries per time bucket. Pure, so the rules can be
// tested without React or Chart.js.
import type { UsageRow } from "../api/usage"

/** What one line of the trend chart stands for. */
export type ChartGrouping = "user" | "model"
/** Which model a row counts under: the one served (routed) or the one asked for (incoming). */
export type ModelKind = "routed" | "incoming"

/** Lines a per-model chart shows when it first draws; the rest wait in the legend. */
export const DEFAULT_VISIBLE_MODELS = 6

/**
 * Per person until an admin picks one, then per model. A non-admin only ever
 * sees their own usage, so for them a person is always picked. Tokens of
 * different models do not add up to anything meaningful, which is why a
 * person's usage is split by model rather than summed.
 */
export function chartGrouping(isAdmin: boolean, userFilter: string): ChartGrouping {
  return isAdmin && !userFilter ? "user" : "model"
}

export interface UsageChartSeries {
  id: string
  label: string
  /** Plotted value per bucket: tokens (cache included) or requests. */
  data: number[]
  /** USD per bucket. */
  cost: number[]
  /** Cache tokens per bucket, already inside `data`; zero for the requests metric. */
  cache: number[]
  /** Starts hidden; its legend entry can show it. */
  hidden: boolean
}

export interface UsageChartInput {
  rows: readonly UsageRow[]
  /** The buckets the chart draws, in order. */
  bucketKeys: readonly string[]
  /** The bucket a row falls in, in the same key space as `bucketKeys`. */
  bucketOf: (row: UsageRow) => string
  grouping: ChartGrouping
  modelKind: ModelKind
  metric: "tokens" | "requests"
  /** Who a row is attributed to, for per-person lines. */
  person: (row: UsageRow) => { id: string; label: string }
  /** Label for a row with no model recorded. */
  unknownLabel: string
}

const rowCache = (row: UsageRow): number => (row.cacheReadTokens ?? 0) + (row.cacheCreationTokens ?? 0)

const rowValue = (row: UsageRow, metric: UsageChartInput["metric"]): number =>
  metric === "requests" ? row.requests ?? 0 : (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + rowCache(row)

function modelOf(row: UsageRow, kind: ModelKind, unknownLabel: string): { id: string; label: string } {
  const model = kind === "incoming" ? row.incomingModel : row.model
  return model ? { id: `model:${model}`, label: model } : { id: "missing:", label: unknownLabel }
}

export function buildUsageChartSeries(input: UsageChartInput): UsageChartSeries[] {
  const position = new Map(input.bucketKeys.map((key, i) => [key, i]))
  const width = input.bucketKeys.length
  const lines = new Map<string, UsageChartSeries & { total: number }>()
  for (const row of input.rows) {
    const at = position.get(input.bucketOf(row))
    if (at === undefined) continue
    const who = input.grouping === "user" ? input.person(row) : modelOf(row, input.modelKind, input.unknownLabel)
    let line = lines.get(who.id)
    if (!line) {
      line = {
        id: who.id,
        label: who.label,
        data: new Array<number>(width).fill(0),
        cost: new Array<number>(width).fill(0),
        cache: new Array<number>(width).fill(0),
        hidden: false,
        total: 0,
      }
      lines.set(who.id, line)
    }
    const value = rowValue(row, input.metric)
    line.data[at] = (line.data[at] ?? 0) + value
    line.cost[at] = (line.cost[at] ?? 0) + (typeof row.cost?.totalUSD === "number" ? row.cost.totalUSD : 0)
    if (input.metric === "tokens") line.cache[at] = (line.cache[at] ?? 0) + rowCache(row)
    line.total += value
  }
  const ordered = [...lines.values()]
  // People keep the order they first appear in, as the chart always drew them.
  if (input.grouping === "model") {
    ordered.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
    ordered.forEach((line, i) => { line.hidden = i >= DEFAULT_VISIBLE_MODELS })
  }
  return ordered.map(({ total: _total, ...line }) => line)
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test apps/dashboard/src/state/usage-chart.test.ts`
Expected: PASS（10 pass）。

---

### Task 4: `useUsage` 改用新纯函数，并共享模型种类

**Files:**
- Modify: `apps/dashboard/src/state/usage.ts`

- [ ] **Step 1: 导入和状态**

在 `usage.ts` 的导入区（`./usage-model-dimensions` 导入之后）加入：

```ts
import { buildUsageChartSeries, chartGrouping, type ModelKind } from "./usage-chart"
```

在 `useUsage` 中 `const [metric, setMetric] = useState<UsageMetric>("tokens")` 之后加入：

```ts
  // Shared by the trend chart and the model distribution table, so the two
  // always count a row under the same model.
  const [modelKind, setModelKind] = useState<ModelKind>("routed")
```

- [ ] **Step 2: 替换 `chart` 的计算**

把从注释 `// Chart series: group by the first un-filtered dimension (user > key > client > model).` 开始、到 `}, [filtered, data, range, periodOffset, endDate, metric, filters, isAdmin, participants, mode])` 结束的整段 `chart` 替换为：

```ts
  // One line per person until an admin picks one, then one per model (see
  // usage-chart.ts). Per-person token lines get a dashed "Cache" line for the
  // cache traffic inside them; per-model lines carry their own cache in the
  // tooltip instead, because a cache total across models adds up nothing.
  const chart = useMemo(() => {
    const ops = zoneOps(mode)
    const { keys, labels, isDaily } = buildTimeBuckets(range, periodOffset, new Date(), endDate, mode)
    const grouping = chartGrouping(isAdmin, filters.user)
    const series = buildUsageChartSeries({
      rows: filtered,
      bucketKeys: keys,
      bucketOf: (r) => utcHourToBucketKey(r.hour, isDaily, ops),
      grouping,
      modelKind,
      metric,
      person: (r) => usageAttribution(participants, r.keyId),
      unknownLabel: t("dash.unknown"),
    })
    const cacheData = keys.map((_, i) => series.reduce((sum, s) => sum + (s.cache[i] ?? 0), 0))
    const cacheHasData = grouping === "user" && metric === "tokens" && cacheData.some((v) => v > 0)
    return { labels, series, grouping, cacheData: cacheHasData ? cacheData : null, bucketKeys: keys, isDaily }
  }, [filtered, range, periodOffset, endDate, metric, filters.user, isAdmin, participants, mode, modelKind, t])
```

- [ ] **Step 3: 导出新状态**

在 `useUsage` 的返回对象中，`metric,` 之后加入 `modelKind,`；`setMetric,` 之后加入 `setModelKind,`。

- [ ] **Step 4: 类型检查与测试**

Run: `cd apps/dashboard && bun run typecheck`
Expected: 无错误输出（`UsageTab` 仍用自己的局部状态，到 Task 6 才切换，此时不受影响）。

Run: `bun test apps/dashboard/src/state`
Expected: 全部 PASS。

---

### Task 5: `TimeSeriesChart` 的可选参数

**Files:**
- Modify: `apps/dashboard/src/components/TimeSeriesChart.tsx`
- Test: `apps/dashboard/src/components/tooltip-text.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `apps/dashboard/src/components/tooltip-text.test.ts`：

```ts
import { describe, expect, test } from "bun:test"
import { sortTooltipRows, tooltipValueText, type TooltipRow } from "./TimeSeriesChart"

describe("sortTooltipRows", () => {
  test("lists the largest value first without changing the input", () => {
    const rows: TooltipRow[] = [
      { label: "a", value: 1, color: "#000" },
      { label: "b", value: 30, color: "#000" },
      { label: "c", value: 7, color: "#000" },
    ]
    expect(sortTooltipRows(rows).map((r) => r.label)).toEqual(["b", "c", "a"])
    expect(rows.map((r) => r.label)).toEqual(["a", "b", "c"])
  })
})

describe("tooltipValueText", () => {
  const cache = (n: number) => `incl. ${n.toLocaleString("en-US")} cache`

  test("names the cache share when a formatter is given and there is cache", () => {
    expect(tooltipValueText(1200, " tokens", 900, cache)).toBe(`${(1200).toLocaleString()} tokens (incl. 900 cache)`)
  })

  test("is the bare value without cache or without a formatter", () => {
    expect(tooltipValueText(1200, " tokens", 0, cache)).toBe(`${(1200).toLocaleString()} tokens`)
    expect(tooltipValueText(1200, " tokens", 900)).toBe(`${(1200).toLocaleString()} tokens`)
    expect(tooltipValueText(3, " req", undefined, cache)).toBe("3 req")
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test apps/dashboard/src/components/tooltip-text.test.ts`
Expected: FAIL，`Export named 'sortTooltipRows' not found`。

- [ ] **Step 3: 数据集与参数类型**

在 `ChartDataset` 接口中 `costData?: number[]` 之后加入：

```ts
  /** Starts hidden; clicking its legend entry shows it. */
  hidden?: boolean
  /**
   * Cache tokens per bucket, aligned with `data` and already inside it. Named
   * in the tooltip so a token count can be read as fresh versus cached.
   */
  cacheData?: number[]
```

在 `Props` 接口中 `totalCostLabel?: string` 之后加入：

```ts
  /** List tooltip rows from the largest value down. */
  sortTooltip?: boolean
  /** Tooltip note for a row's cache tokens, e.g. "incl. 1,234 cache". Localised by the caller. */
  formatCache?: (tokens: number) => string
```

在 `TooltipRow` 接口中 `cost?: number` 之后加入：

```ts
  /** Cache tokens inside `value`, when the series reports them. */
  cache?: number
```

- [ ] **Step 4: 纯函数**

在 `tooltipTotalCost` 函数之后加入：

```ts
/** Largest value first; the input is left as it was. */
export function sortTooltipRows(rows: TooltipRow[]): TooltipRow[] {
  return [...rows].sort((a, b) => b.value - a.value)
}

/** A row's value as the tooltip shows it, with its cache share when there is one to name. */
export function tooltipValueText(
  value: number,
  unitLabel: string,
  cache: number | undefined,
  formatCache?: (tokens: number) => string,
): string {
  const note = formatCache && typeof cache === "number" && cache > 0 ? ` (${formatCache(cache)})` : ""
  return `${value.toLocaleString()}${unitLabel}${note}`
}
```

- [ ] **Step 5: 组件接入**

函数签名改为：

```ts
export function TimeSeriesChart({ labels, datasets, height = 300, unitLabel = "", yTickFormat, pointLink, totalCostLabel = "Total cost", sortTooltip = false, formatCache }: Props) {
```

在 `costRef.current = datasets.map((d) => d.costData ?? null)` 之后加入：

```ts
  const cacheRef = useRef<Array<number[] | null>>([])
  cacheRef.current = datasets.map((d) => d.cacheData ?? null)
  // Through a ref for the same reason as pointLink: callers pass a fresh
  // function every render, and the chart must not rebuild for it.
  const formatCacheRef = useRef(formatCache)
  formatCacheRef.current = formatCache
  // Legend choices by line name. The chart is rebuilt whenever its data
  // changes — every auto-refresh — and a model the user switched on or off
  // should stay that way rather than snap back to the default.
  const legendChoices = useRef(new Map<string, boolean>())
```

`cjDatasets` 的映射中，在 `tension: 0.25,` 之后加入：

```ts
      hidden: legendChoices.current.get(d.label) ?? d.hidden ?? false,
```

`plugins.legend` 改为：

```ts
          legend: {
            display: true,
            labels: { color: tickC, font: { family: "Outfit, sans-serif", size: 11 } },
            onClick: (_event, item, legend) => {
              const index = item.datasetIndex
              if (index === undefined) return
              const chart = legend.chart
              const hide = chart.isDatasetVisible(index)
              chart.setDatasetVisibility(index, !hide)
              chart.update()
              legendChoices.current.set(String(chart.data.datasets[index]?.label ?? ""), hide)
            },
          },
```

`plugins.tooltip` 的非链接分支改为：

```ts
            : {
                ...(sortTooltip ? { itemSort: (a, b) => Number(b.parsed.y) - Number(a.parsed.y) } : {}),
                callbacks: {
                  label: (c) => {
                    const cost = costRef.current[c.datasetIndex]?.[c.dataIndex]
                    const cache = cacheRef.current[c.datasetIndex]?.[c.dataIndex]
                    const suffix = typeof cost === "number" && cost > 0 ? `  ·  ${formatTooltipCost(cost)}` : ""
                    return `${c.dataset.label}: ${tooltipValueText(Number(c.parsed.y), unitLabel, cache, formatCacheRef.current)}${suffix}`
                  },
                },
              },
```

链接分支的调用改为（追加一个参数对象）：

```ts
            ? { enabled: false, external: (ctx) => renderLinkTooltip(ctx, tooltipRef.current, unitLabel, linkRef, hideTimer, overTip, costRef, totalCostLabel, { cacheRef, formatCacheRef, sort: sortTooltip }) }
```

`useEffect` 的依赖数组末尾加入 `sortTooltip`：

```ts
  }, [labels, datasets, height, unitLabel, yTickFormat, themeTick, hasPointLink, totalCostLabel, sortTooltip])
```

- [ ] **Step 6: 链接提示框**

`renderLinkTooltip` 的参数列表在 `totalCostLabel: string,` 之后加入：

```ts
  extras: {
    cacheRef: { current: Array<number[] | null> }
    formatCacheRef: { current: ((tokens: number) => string) | undefined }
    sort: boolean
  },
```

把 `allRows` 的构造和 `rows` 的渲染（从 `const allRows: TooltipRow[] = tooltip.dataPoints.map((p) => {` 到 `.join("")`）替换为：

```ts
  const allRows: TooltipRow[] = tooltip.dataPoints.map((p) => {
    const cost = costRef.current[p.datasetIndex]?.[p.dataIndex]
    const cache = extras.cacheRef.current[p.datasetIndex]?.[p.dataIndex]
    return {
      label: String(p.dataset.label ?? ""),
      value: Number(p.parsed.y),
      color: String(p.dataset.borderColor ?? ""),
      ...(typeof cost === "number" ? { cost } : {}),
      ...(typeof cache === "number" ? { cache } : {}),
    }
  })
  const rows = visibleTooltipRows(extras.sort ? sortTooltipRows(allRows) : allRows)
    .map((r) => {
      const costHtml =
        typeof r.cost === "number" && r.cost > 0
          ? `<span class="pg-chart-tip-cost">${escapeHtml(formatTooltipCost(r.cost))}</span>`
          : ""
      const valueText = tooltipValueText(r.value, unitLabel, r.cache, extras.formatCacheRef.current)
      return `<div class="pg-chart-tip-row"><span class="pg-chart-tip-dot" style="background:${escapeHtml(r.color)}"></span>${escapeHtml(r.label)}<b>${escapeHtml(valueText)}${costHtml}</b></div>`
    })
    .join("")
```

- [ ] **Step 7: 运行**

Run: `bun test apps/dashboard/src/components`
Expected: 全部 PASS（含新增 3 个）。

Run: `cd apps/dashboard && bun run typecheck`
Expected: 无错误输出。

---

### Task 6: Usage 页接入

**Files:**
- Modify: `apps/dashboard/src/tabs/usage/UsageTab.tsx`
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts`

- [ ] **Step 1: 文案**

在 `i18n.ts` 中，英文段的 `"dash.tooltipTotalCost": "Total cost",` 之后加入：

```ts
      "dash.chartLinesByUser": "One line per user. Pick a user to split their usage by model.",
      "dash.chartLinesByRoutedModel": "One line per routed model, busiest first. Click a legend entry to show or hide a model.",
      "dash.chartLinesByIncomingModel": "One line per incoming model, busiest first. Click a legend entry to show or hide a model.",
      "dash.tooltipCacheShare": "incl. {n} cache",
```

中文段的 `"dash.tooltipTotalCost": "总费用",` 之后加入：

```ts
      "dash.chartLinesByUser": "每个用户一条线。选择一个用户后，按模型拆分其用量。",
      "dash.chartLinesByRoutedModel": "每个路由模型一条线，按用量从高到低。点击图例可显示或隐藏模型。",
      "dash.chartLinesByIncomingModel": "每个传入模型一条线，按用量从高到低。点击图例可显示或隐藏模型。",
      "dash.tooltipCacheShare": "含缓存 {n}",
```

- [ ] **Step 2: 去掉局部状态，改用共享状态**

删除 `UsageTab` 中这一行：

```tsx
  const [modelDistribution, setModelDistribution] = useState<"routed" | "incoming">("routed")
```

把模型分布区里的 `value={modelDistribution}` 和 `onChange={setModelDistribution}` 改为 `value={usage.modelKind}` 和 `onChange={usage.setModelKind}`；把 `UsageDistributionTable` 上的三处 `modelDistribution === "routed"` / `modelDistribution === "incoming"` 改为 `usage.modelKind === "routed"` / `usage.modelKind === "incoming"`。

在 `METRIC_OPTIONS` 定义之后加入（模型分布区原有的选项数组也改用它）：

```tsx
  const MODEL_KIND_OPTIONS: Array<{ id: "routed" | "incoming"; label: string }> = [
    { id: "routed", label: t("dash.routedModel") },
    { id: "incoming", label: t("dash.incomingModel") },
  ]
```

模型分布区的 `SegmentedGroup` 改为：

```tsx
        <SegmentedGroup
          options={MODEL_KIND_OPTIONS}
          value={usage.modelKind}
          onChange={usage.setModelKind}
          ariaLabel={t("dash.modelDistributionToggle")}
        />
```

- [ ] **Step 3: 数据集**

把 `chartDatasets` 的 `useMemo` 中 `usage.chart.series.map(...)` 那段改为：

```tsx
    const series: ChartDataset[] = usage.chart.series.map((s, i) => ({
      label: s.label,
      data: s.data,
      color: palette[i % palette.length] ?? "#888888",
      costData: s.cost,
      // Per-model lines cross one another, and filled areas would bury the
      // lower ones; each line names its own cache in the tooltip instead.
      ...(usage.chart.grouping === "model" ? { fill: false, hidden: s.hidden, cacheData: s.cache } : {}),
    }))
```

（`if (usage.chart.cacheData) { … }` 一段保持不变：只有按用户分线时 `cacheData` 才非空。）

- [ ] **Step 4: 说明行和图表参数**

把

```tsx
        <div className="mt-2">
          <TimeSeriesChart
```

之前插入说明行（按模型分线时右侧带同一个切换）：

```tsx
        <div className="flex items-center justify-between gap-3 flex-wrap mt-2">
          <p className="text-[11px] text-themed-dim">
            {usage.chart.grouping === "user"
              ? t("dash.chartLinesByUser")
              : t(usage.modelKind === "routed" ? "dash.chartLinesByRoutedModel" : "dash.chartLinesByIncomingModel")}
          </p>
          {usage.chart.grouping === "model" ? (
            <SegmentedGroup
              options={MODEL_KIND_OPTIONS}
              value={usage.modelKind}
              onChange={usage.setModelKind}
              ariaLabel={t("dash.modelDistributionToggle")}
            />
          ) : null}
        </div>
```

`TimeSeriesChart` 上加入两个参数：

```tsx
            sortTooltip={usage.chart.grouping === "model"}
            formatCache={(n) => t("dash.tooltipCacheShare", { n: n.toLocaleString() })}
```

- [ ] **Step 5: 检查**

Run: `bun test apps/dashboard packages/gateway/tests/i18n-keys.test.ts`
Expected: 全部 PASS。

Run: `cd apps/dashboard && bun run typecheck`
Expected: 无错误输出。

Run: `bun run lint 2>&1 | grep -A3 "tabs/usage\|state/usage\|TimeSeriesChart"`
Expected: 不出现本次改动引入的新警告（`ModelsTab.tsx:80` 那条是原有的，与本次无关）。

---

### Task 7: 浏览器验证、全量检查、交付

**Files:** 无代码改动。

- [ ] **Step 1: 构建界面**

Run: `bun run build:ui`
Expected: `[build-dashboard] wrote … dashboard.js and dashboard.css`。

- [ ] **Step 2: 临时网关（数据库副本，不碰运行中的数据）**

```bash
D=/tmp/usage-chart-verify; mkdir -p $D && chmod 700 $D
docker exec copilot-gateway-vnext-bootstrap bun -e "new (require('bun:sqlite').Database)('/data/vnext.sqlite',{readonly:true}).exec(\"VACUUM INTO '/tmp/ucv.sqlite'\")"
docker cp -q copilot-gateway-vnext-bootstrap:/tmp/ucv.sqlite $D/vnext.sqlite && docker exec copilot-gateway-vnext-bootstrap rm -f /tmp/ucv.sqlite && chmod 600 $D/vnext.sqlite
# A throwaway admin session in the copy only; the token never leaves the file.
umask 077; printf 'ses_%s' "$(openssl rand -hex 32)" > $D/session.token
OWNER=$(sqlite3 $D/vnext.sqlite "select owner_id from api_keys where name='parity-admin-bootstrap'")
sqlite3 $D/vnext.sqlite "insert into user_sessions (token, user_id, created_at, expires_at, authenticated_at) values ('$(cat $D/session.token)', '$OWNER', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'), cast(strftime('%s','now') as integer)*1000)"
(cd $D && VNEXT_DB_PATH=$D/vnext.sqlite PORT=41499 NODE_ENV=production ACCOUNT_TYPE=individual nohup bun /Volumes/Projects/copilot-api-gateway/vnext/apps/platform-bun/src/server.ts > server.log 2>&1 & echo $! > $D/server.pid)
```

再写一个只监听 127.0.0.1:41498 的小服务，从 `$D/session.token` 读取 token、设置 `session_token` cookie 后 302 到 `http://127.0.0.1:41499/dashboard#usage`（与 2026-11-07 验证 decision 面板时的 `cookie-helper.ts` 相同，只把落地页改为 `#usage`）。用独立 profile 启动 Chrome（`--remote-debugging-port=9333 --user-data-dir=$D/chrome-profile`），通过 chrome-devtools 打开 `http://127.0.0.1:41498/`。

- [ ] **Step 3: 逐项检查并截图**

1. 管理员、未选用户：每个用户一条线，线下有填充，有 Cache 虚线；说明行显示"每个用户一条线…"。
2. 选定一个用户：每个模型一条线，无填充、无 Cache 线；默认最多显示 6 条，其余在图例中为划掉状态；说明行显示"每个路由模型一条线…"，旁边有路由/传入切换。
3. 悬停：按值从高到低，每行带"含缓存 N"和费用。范围切到"周"再悬停，确认链接提示框同样排序并带缓存说明。
4. 点击图例显示一个隐藏的模型，再点刷新按钮：该模型仍然显示。
5. 切换到"传入模型"：趋势图与下方分布表同时切换。
6. 月份切回 2026-09（`‹` 翻页）：传入模型筛选与分布表里没有 Legacy。
7. 深色主题下重复第 2、3 项。

- [ ] **Step 4: 清理**

```bash
D=/tmp/usage-chart-verify; for f in server.pid helper.pid chrome.pid; do kill $(cat $D/$f) 2>/dev/null; done; rm -rf $D
```

- [ ] **Step 5: 全量检查**

Run: `bun run ci:local`
Expected: 只有两个已知与本次无关的失败（`reference-adapter` 研究脚手架；高负载下 `usage-detail-capacity` 超时，可单独重跑确认）。

- [ ] **Step 6: 交付**

向用户汇报结果和截图，**询问是否提交、推送和部署**；确认后再按发布流程（见记忆 `lab-docker-release-process`）执行。提交信息：

```
feat(vnext/dashboard): split a person's usage trend by model

Co-Authored-By: Claude <noreply@anthropic.com>
```
