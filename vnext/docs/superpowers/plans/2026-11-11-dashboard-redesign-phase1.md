# Dashboard 重设计第一期：底座和外框 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 dashboard 升级到 Tailwind 4，换上 Vercel 风格的设计规范，用左侧分组导航取代顶部 Tab，并把默认首页改为"用量"。所有页面的功能和页面内部代码保持不变。

**Architecture:**
1. 先做一次界面完全不变的 Tailwind 3 → 4 升级，主题移进 `styles.css` 的 `@theme inline`。
2. 再换颜色、字体和共享样式类的取值。旧类名保留，各页面不改代码就会套上新风格。
3. 新建 `src/ui/` 基础组件（shadcn 做法：Radix + cva + tailwind-merge）和 `src/shell/` 外框：导航模型、侧栏、移动端抽屉、面包屑、账户菜单。替换 `components/Layout.tsx`。

**Tech Stack:** React 19、Tailwind 4.3（`@tailwindcss/cli`）、Radix UI（dialog、dropdown-menu、tooltip、slot）、class-variance-authority、clsx、tailwind-merge 3、lucide-react、Geist / Geist Mono 字体、bun test。

**Spec:** `docs/superpowers/specs/2026-11-11-dashboard-redesign-design.md`

---

## 背景（实现者必读）

- 工作目录是 worktree `/Volumes/Projects/copilot-api-gateway/.worktrees/dashboard-redesign/vnext`，分支 `feat/vnext-dashboard-redesign-shell`。所有命令都在这里执行，下文的相对路径都以它为根。
- **不要 `git stash`**（stash 栈和其他会话共享）。**不要提交**：全部任务完成并经用户确认后，由主控统一提交。
- 依赖已经装好并写进了 `apps/dashboard/package.json` 和 `bun.lock`：
  - `@radix-ui/react-dialog@^1.3.1`、`@radix-ui/react-dropdown-menu@^2.2.1`、`@radix-ui/react-slot@^1.5.0`、`@radix-ui/react-tooltip@^1.4.1`
  - `class-variance-authority@^0.7.1`、`clsx@^2.1.1`、`tailwind-merge@^3.7.0`、`lucide-react@^1.71.0`
  - devDependencies：`tailwindcss@^4.3.5`、`@tailwindcss/cli@^4.3.5`

  如需再装包：`BUN_CONFIG_REGISTRY=https://mirrors.cloud.tencent.com/npm/ bun add --backend=copyfile <pkg>`。官方 npm 源在这台机器上不通。
- Dashboard 构建：`bun run build:ui`。它运行 `scripts/build-dashboard.ts`，产物写到 `packages/gateway/src/shared/edge/ui-pages/dashboard-app/dist/`。HTML 外壳是 `packages/gateway/src/shared/edge/ui-pages/dashboard-app/page.ts`，负责：
  - 注入字体链接；
  - 注入 `toggleTheme()`：切换 `<html data-theme>`，并派发 `theme-changed` 事件；
  - 通过 `renderI18nScript()` 注入 `window.t`、`window.__lang` 和 `toggleLang()`（切换后刷新页面）。
- 测试：
  - 运行 `bun test apps/dashboard`。
  - 组件测试用 `react-dom/server` 的 `renderToStaticMarkup`，没有 DOM 环境，所以键盘交互放到 Task 7 的浏览器检查里验证。
  - `packages/gateway/tests/i18n-keys.test.ts` 会扫描 dashboard 源码中所有字面量 `t("…")`，要求键在中英文两份字典里都存在。因此导航文案必须写成字面量 `t("dash.xxx")`，不能写成 `t(variable)`。
- 类型检查：`cd apps/dashboard && bun run typecheck`。Lint：`bun run lint`（只关心本次改动的文件）。
- 文件路径没有别名，一律用相对导入。
- 基线体积：`dashboard.js` 893,422 字节，gzip 后 275,726 字节。预算是比基线多 300 KB 以内。

## 文件结构

| 文件 | 职责 |
|---|---|
| `apps/dashboard/src/styles.css`（改） | Tailwind 4 入口、`@theme inline`、浅色/深色变量、共享样式类 |
| `tailwind.config.ts`（删） | 主题移进 CSS |
| `scripts/build-dashboard.ts`（改） | 改用 v4 CLI |
| `packages/gateway/src/shared/edge/ui-pages/dashboard-app/page.ts`（改） | 字体链接换成 Geist |
| `apps/dashboard/src/ui/cn.ts`（新） | 合并类名 |
| `apps/dashboard/src/ui/button.tsx`（新） | 按钮 |
| `apps/dashboard/src/ui/tooltip.tsx`（新） | 提示 |
| `apps/dashboard/src/ui/dropdown-menu.tsx`（新） | 菜单 |
| `apps/dashboard/src/ui/sheet.tsx`（新） | 侧边抽屉 |
| `apps/dashboard/src/shell/navigation.ts`（新） | 导航分组、权限过滤、默认页、定位当前页（纯函数） |
| `apps/dashboard/src/shell/use-media-query.ts`（新） | 断点监听 |
| `apps/dashboard/src/shell/use-theme.ts`（新） | 读取并切换主题 |
| `apps/dashboard/src/shell/SidebarNav.tsx`（新） | 分组导航列表 |
| `apps/dashboard/src/shell/Sidebar.tsx`（新） | 桌面侧栏和侧栏底部 |
| `apps/dashboard/src/shell/MobileTopBar.tsx`（新） | 手机顶栏和抽屉 |
| `apps/dashboard/src/shell/PageCrumb.tsx`（新） | 面包屑 |
| `apps/dashboard/src/shell/AppShell.tsx`（新） | 整体布局 |
| `apps/dashboard/src/components/UserMenu.tsx`（改） | 菜单换成 Radix，选项和弹窗不变 |
| `apps/dashboard/src/components/AgentRemoteEntry.tsx`（改） | 换成侧栏条目样式 |
| `apps/dashboard/src/components/Layout.tsx`（删） | 被 AppShell 取代 |
| `apps/dashboard/src/App.tsx`（改） | 使用 navigation 和 AppShell，默认页为用量 |
| `packages/gateway/src/shared/edge/ui-pages/i18n.ts`（改） | 新增导航文案 |

## 附录 A：预览环境（Task 1 和 Task 7 使用）

在本地 Docker 数据库的副本上起临时网关，用独立的 Chrome profile 打开；不碰正在运行的容器和数据。截图保存到 `/Volumes/Projects/copilot-api-gateway/.superpowers/sdd/dashboard-redesign/`（该目录被 git 忽略；`/tmp` 不在截图工具允许的路径内）。

```bash
W=/Volumes/Projects/copilot-api-gateway/.worktrees/dashboard-redesign/vnext
D=/tmp/dash-redesign-preview; mkdir -p $D && chmod 700 $D
S=/Volumes/Projects/copilot-api-gateway/.superpowers/sdd/dashboard-redesign; mkdir -p $S
docker exec copilot-gateway-vnext-bootstrap bun -e "new (require('bun:sqlite').Database)(process.env.VNEXT_DB_PATH,{readonly:true}).exec(\"VACUUM INTO '/tmp/dr.sqlite'\")"
docker cp -q copilot-gateway-vnext-bootstrap:/tmp/dr.sqlite $D/vnext.sqlite && docker exec copilot-gateway-vnext-bootstrap rm -f /tmp/dr.sqlite && chmod 600 $D/vnext.sqlite
umask 077
# Two throwaway sessions in the copy only: the admin (owner of parity-admin-bootstrap) and the non-admin "Parity Target".
ADMIN=$(sqlite3 $D/vnext.sqlite "select owner_id from api_keys where name='parity-admin-bootstrap'")
for who in admin user; do printf 'ses_%s' "$(openssl rand -hex 32)" > $D/$who.token; done
ins() { sqlite3 $D/vnext.sqlite "insert into user_sessions (token, user_id, created_at, expires_at, authenticated_at) values ('$(cat $D/$1.token)', '$2', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'), cast(strftime('%s','now') as integer)*1000)"; }
ins admin $ADMIN; ins user 00000000-0000-4000-a000-0000000000b2
(cd $D && VNEXT_DB_PATH=$D/vnext.sqlite PORT=41499 NODE_ENV=production ACCOUNT_TYPE=individual nohup bun $W/apps/platform-bun/src/server.ts > server.log 2>&1 & echo $! > server.pid)
cat > $D/helper.ts <<'EOF'
// GET /admin or /user sets that session's cookie and lands on /dashboard (no hash, so the default tab shows).
const dir = process.argv[2]!
Bun.serve({ hostname: "127.0.0.1", port: 41498, async fetch(req) {
  const who = new URL(req.url).pathname === "/user" ? "user" : "admin"
  const token = (await Bun.file(`${dir}/${who}.token`).text()).trim()
  return new Response(null, { status: 302, headers: { "set-cookie": `session_token=${token}; Path=/; HttpOnly; SameSite=Lax`, location: "http://127.0.0.1:41499/dashboard" } })
} })
EOF
(nohup bun $D/helper.ts $D > $D/helper.log 2>&1 & echo $! > $D/helper.pid)
("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9333 --user-data-dir=$D/chrome-profile --no-first-run --window-size=1440,1000 about:blank > $D/chrome.log 2>&1 & echo $! > $D/chrome.pid)
sleep 4; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:41499/health   # expect 200
```

- 打开 `http://127.0.0.1:41498/admin` 或 `/user` 即以对应身份登录。chrome-devtools MCP 已配置连接 `127.0.0.1:9333`。
- 改了前端代码后：运行 `bun run build:ui`，再重启网关（`kill $(cat $D/server.pid)`，然后重新执行上面启动 server 的那一行）。
- 用 `curl -s -b "session_token=$(cat $D/admin.token)" http://127.0.0.1:41499/dashboard | grep -c <新代码里的某个字符串>` 确认页面上跑的是新包。
- 如果 `apps/platform-bun/node_modules/@vibe-llm/gateway` 解析到的不是 worktree（用 `cd … && pwd -P` 检查），说明 node_modules 是链接，要用 rsync 复制一份真实目录，不能跑到主目录的旧代码。

清理：

```bash
D=/tmp/dash-redesign-preview; for f in server.pid helper.pid chrome.pid; do kill $(cat $D/$f) 2>/dev/null; done; rm -rf $D
```

---

### Task 1: Tailwind 3 → 4 升级（界面不变）

**Files:**
- Modify: `apps/dashboard/src/styles.css:1-3`
- Delete: `tailwind.config.ts`
- Modify: `scripts/build-dashboard.ts:23-40`
- Modify: `apps/dashboard/src/**/*.tsx`（由升级工具改类名）

- [ ] **Step 1: 升级前的基线截图**

  先 `bun run build:ui`，按附录 A 起预览环境，以管理员登录。宽度 1440、深色主题下，依次打开以下 11 页并截图，保存为 `$S/t1-before-<tab>.png`：
  - `#upstreams`、`#proxies`、`#users`、`#keys`、`#models`、`#pricing`
  - `#usage`（切到"月"）、`#latency`、`#clients`、`#settings`、`#agent-remote`

  完成后保持环境运行。

- [ ] **Step 2: 用官方工具改模板里的类名**

  ```bash
  cd apps/dashboard
  BUN_CONFIG_REGISTRY=https://mirrors.cloud.tencent.com/npm/ bunx @tailwindcss/upgrade@4.3.5 --force -c ../../tailwind.config.ts
  cd ../..
  git status --short
  ```

  - 必须在 `apps/dashboard` 目录里运行。服务端页面 `layout.ts` 用的是 CDN 上的 Tailwind 3，不能被改动。
  - `git status` 中出现 `apps/dashboard/src/`、`apps/dashboard/package.json`、`bun.lock`、`tailwind.config.ts` 以外的改动时，用 `git checkout -- <path>` 还原。
  - 用 `git checkout -- apps/dashboard/src/styles.css apps/dashboard/package.json` 还原工具对样式表和 package.json 的改动：样式表在下一步手写，依赖已经装好。
  - 工具可能删掉 `tailwind.config.ts`；没删的话，在 Step 4 删。

- [ ] **Step 3: 检查工具改了什么**

  ```bash
  git diff --stat -- apps/dashboard/src
  git diff -U0 -- apps/dashboard/src | grep '^[-+]' | grep -v '^[-+][-+]' | head -80
  ```

  预期只有 v4 的类名改名，例如：
  - `shadow` → `shadow-sm`，`shadow-sm` → `shadow-xs`
  - `rounded` → `rounded-sm`，`rounded-sm` → `rounded-xs`
  - `blur` → `blur-sm`
  - `outline-none` → `outline-hidden`
  - `ring` → `ring-3`
  - `bg-accent-violet/20` 这类带透明度的写法不变

  如果有逻辑代码或文案被改动，例如字符串里恰好出现 `shadow` 一词，逐处还原。

- [ ] **Step 4: 手写 v4 样式入口**

  把 `apps/dashboard/src/styles.css` 开头三行：

  ```css
  @tailwind base;
  @tailwind components;
  @tailwind utilities;
  ```

  换成下面的内容。文件其余部分不动：`.glass-card`、`.btn-primary` 等共享类继续写在任何 layer 之外，和 v3 时一样优先于工具类。

  ```css
  @import "tailwindcss" source(none);
  @source "./**/*.{ts,tsx}";

  /* Tailwind 3's theme, carried over unchanged. `inline` keeps var()-backed
     colours resolving per [data-theme] on <html>. */
  @theme inline {
    --font-sans: "Outfit", system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", monospace;
    --color-surface-900: var(--surface-900);
    --color-surface-800: var(--surface-800);
    --color-surface-700: var(--surface-700);
    --color-surface-600: var(--surface-600);
    --color-surface-500: var(--surface-500);
    --color-accent-violet: #8b5cf6;
    --color-accent-violetDim: #7c3aed;
    --color-accent-violetGlow: rgba(139, 92, 246, 0.15);
    --color-accent-cyan: #06b6d4;
    --color-accent-teal: #10b981;
    --color-accent-amber: #f59e0b;
    --color-accent-red: #ef4444;
  }

  /* v3 defaults that v4 dropped, so nothing moves in this step. */
  @layer base {
    *, ::after, ::before, ::backdrop, ::file-selector-button {
      border-color: var(--color-gray-200, currentcolor);
    }
    button:not(:disabled), [role="button"]:not(:disabled) {
      cursor: pointer;
    }
    input::placeholder, textarea::placeholder {
      color: var(--color-gray-400);
    }
  }
  ```

  然后删除配置文件：`git rm -q tailwind.config.ts`（工具已删除的话跳过）。

- [ ] **Step 5: 构建脚本改用 v4 CLI**

  把 `scripts/build-dashboard.ts` 中从 `// The content glob is passed absolute` 注释开始、到 `await $\`${tailwindBin} …\`.quiet()` 这一行为止的整段，替换为：

  ```ts
  // Tailwind 4 reads its sources from styles.css (`@source`, relative to the
  // stylesheet), so no content glob or config file is passed here.
  //
  // The binary is the dashboard's own @tailwindcss/cli. Do not fall back to a
  // hoisted root bin: an older install there may still be the v3 CLI, which
  // would silently mis-build a v4 stylesheet.
  const tailwindBin = `${root}/apps/dashboard/node_modules/.bin/tailwindcss`
  if (!(await Bun.file(tailwindBin).exists())) throw new Error(`tailwindcss CLI not found at ${tailwindBin}; run bun install`)
  const version = await $`${tailwindBin} --help`.quiet().nothrow().text()
  if (!version.includes("tailwindcss v4")) throw new Error(`expected the Tailwind 4 CLI at ${tailwindBin}`)
  await $`${tailwindBin} -i ${src}/styles.css -o ${out}/dashboard.css --minify`.quiet()
  ```

  后面写 `.txt` 的代码保持不变。原来的 `css.length < 30_000` 检查改为检查产物里有 `.text-accent-violet`：v4 的空扫描产物也接近 30KB，按长度检查已经拦不住。

- [ ] **Step 6: 构建、测试、类型检查**

  ```bash
  bun run build:ui
  bun test apps/dashboard packages/gateway/tests/i18n-keys.test.ts 2>&1 | grep -E "^ *[0-9]+ (pass|fail)$|^\(fail\)"
  (cd apps/dashboard && bun run typecheck)
  ```

  预期：
  - 构建输出 `[build-dashboard] wrote …`；
  - 测试 0 fail，dashboard 共 551 个通过；
  - 类型检查无报错。

- [ ] **Step 7: 对比截图**

  重启预览网关，同样以 1440 宽、深色主题依次打开 Step 1 的 11 页，截图保存为 `$S/t1-after-<tab>.png`，逐对与 `t1-before-` 比较。

  允许的差别只有字体抗锯齿这类像素级差异。如果出现边框颜色、圆角、阴影、焦点环、间距或光标方面的差异，在 `styles.css` 的 `@layer base` 或对应类名上修正，直到一致。修正项记录在任务报告里。

---

### Task 2: 设计规范（颜色、字体、共享样式）

**Files:**
- Modify: `apps/dashboard/src/styles.css`
- Modify: `packages/gateway/src/shared/edge/ui-pages/dashboard-app/page.ts`
- Modify: `apps/dashboard/src/components/TimeSeriesChart.tsx`（图表字体）

- [ ] **Step 1: 换字体链接**

  在 `page.ts` 中，把

  ```html
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  ```

  换成

  ```html
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  ```

- [ ] **Step 2: 替换主题块和变量**

  Task 1 之后，`styles.css` 开头依次是：
  1. `@import` 和两行 `@source`；
  2. 一个固定 v3 行高和默认调色板的 `@theme` 块；
  3. 注释 "Tailwind 3's theme, carried over unchanged" 加 `@theme inline { … }`；
  4. `@layer base { … }` 兼容块；
  5. `/* ===== Theme CSS Variables` 开始的主题变量、`body`、共享类和 Inputs 等内容。

  这一步做两处替换，1、2、4 三段保持不变：

  - **替换 A**：把第 3 段（那条注释和整个 `@theme inline { … }` 块）换成下面代码中的 `@theme inline { … }` 块。
  - **替换 B**：把从 `/* ===== Theme CSS Variables` 开始、到 `.scrollbar-hide::-webkit-scrollbar { display: none; }` 这一行为止的全部内容，换成下面代码中 `@theme inline` 块之后的部分（从 `:root,` 开始）。`/* ===== Code blocks` 及之后的内容不动。

  **层级规则（Task 1 发现，务必遵守）：**
  - v4 中不在任何 layer 里的 CSS 会压过所有工具类，不论特异性。
  - 只有在 v3 里本来就能赢过单类工具类的规则（特异性至少 (0,1,1)，例如 `input[type="text"]`、`input:focus`）才可以留在 layer 外。
  - 只写元素名的选择器（`textarea, select`）必须放进 `@layer components`。

  下面的代码已经按这个规则写好。另外，Task 1 已经给若干页面里的 `focus:`、`hover:`、`active:` 工具类加了 `!`，保证它们继续压过共享类，不要去掉这些 `!`。

  ```css
  @theme inline {
    --font-sans: "Geist", ui-sans-serif, system-ui, sans-serif;
    --font-mono: "Geist Mono", ui-monospace, SFMono-Regular, monospace;

    /* Semantic tokens for new code (src/ui, src/shell). */
    --color-background: var(--surface-900);
    --color-panel: var(--surface-800);
    --color-muted: var(--surface-700);
    --color-border: var(--border-color);
    --color-input: var(--input-border);
    --color-fg: var(--text-primary);
    --color-fg-muted: var(--text-secondary);
    --color-fg-subtle: var(--text-dim);
    --color-brand: var(--brand);
    --color-brand-hover: var(--brand-hover);
    --color-brand-fg: var(--brand-foreground);
    --color-ring: var(--ring);
    --color-info: var(--info);
    --color-success: var(--success);
    --color-warn: var(--warn);
    --color-danger: var(--danger);

    /* Legacy names the pages still use; they now follow the new palette. */
    --color-surface-900: var(--surface-900);
    --color-surface-800: var(--surface-800);
    --color-surface-700: var(--surface-700);
    --color-surface-600: var(--surface-600);
    --color-surface-500: var(--surface-500);
    --color-accent-violet: var(--brand);
    --color-accent-violetDim: var(--brand-hover);
    --color-accent-violetGlow: color-mix(in oklab, var(--brand) 15%, transparent);
    --color-accent-cyan: var(--info);
    --color-accent-teal: var(--success);
    --color-accent-amber: var(--warn);
    --color-accent-red: var(--danger);
  }

  :root,
  [data-theme="light"] {
    --surface-900: #ffffff;
    --surface-800: #fafafa;
    --surface-700: #f2f2f2;
    --surface-600: #ebebeb;
    --surface-500: #d4d4d4;
    --text-primary: #0a0a0a;
    --text-secondary: #525252;
    /* #737373 rather than a lighter grey: dim text must still reach 4.5:1 on white. */
    --text-dim: #737373;
    --border-color: #ebebeb;
    --input-border: #d9d9d9;
    --input-bg: #ffffff;
    --brand: #7c3aed;
    --brand-hover: #6d28d9;
    --brand-foreground: #ffffff;
    --ring: color-mix(in oklab, #7c3aed 35%, transparent);
    --info: #0891b2;
    --success: #059669;
    --warn: #b45309;
    --danger: #dc2626;
    --danger-wash: color-mix(in oklab, var(--danger) 10%, transparent);
    --danger-edge: color-mix(in oklab, var(--danger) 35%, transparent);
    /* Retired effects, kept defined so any remaining reference renders flat. */
    --glass-bg: var(--surface-900);
    --glass-bg2: var(--surface-800);
    --glass-border: var(--border-color);
    --glow-color: transparent;
    --glow-border: var(--border-color);
    --card-shadow: none;
  }

  [data-theme="dark"] {
    --surface-900: #0a0a0a;
    --surface-800: #111111;
    --surface-700: #1a1a1a;
    --surface-600: #262626;
    --surface-500: #333333;
    --text-primary: #ededed;
    --text-secondary: #a1a1a1;
    --text-dim: #8f8f8f;
    --border-color: #262626;
    --input-border: #333333;
    --input-bg: #0a0a0a;
    --brand: #8b5cf6;
    --brand-hover: #7c3aed;
    --brand-foreground: #ffffff;
    --ring: color-mix(in oklab, #8b5cf6 45%, transparent);
    --info: #22d3ee;
    --success: #34d399;
    --warn: #fbbf24;
    --danger: #f87171;
    --danger-wash: color-mix(in oklab, var(--danger) 12%, transparent);
    --danger-edge: color-mix(in oklab, var(--danger) 40%, transparent);
    --glass-bg: var(--surface-900);
    --glass-bg2: var(--surface-800);
    --glass-border: var(--border-color);
    --glow-color: transparent;
    --glow-border: var(--border-color);
    --card-shadow: none;
  }

  body {
    background: var(--surface-900);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 14px;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }

  .glass-card {
    background: var(--surface-900);
    border: 1px solid var(--border-color);
    border-radius: 8px;
  }

  .glow-primary { box-shadow: none; }
  .glow-border { border: 1px solid var(--border-color); }

  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .animate-in {
    animation: fadeSlideUp 0.2s ease-out forwards;
    opacity: 0;
  }
  .delay-1 { animation-delay: 0.03s; }
  .delay-2 { animation-delay: 0.06s; }
  .delay-3 { animation-delay: 0.09s; }
  .delay-4 { animation-delay: 0.12s; }
  .delay-5 { animation-delay: 0.15s; }
  @media (prefers-reduced-motion: reduce) {
    .animate-in { animation: none; opacity: 1; }
  }

  .hover-lift { transition: border-color 0.15s ease; }
  .hover-lift:hover { border-color: var(--surface-500); }

  /* Inputs. Layering: unlayered CSS beats every utility in v4, so only rules
     that already beat single-class utilities in v3 — specificity (0,1,1) and
     up — stay unlayered. Element-only selectors live in @layer components so
     a page's own utilities still win, as they did in v3. */
  input[type="text"],
  input[type="password"],
  input[type="email"],
  input[type="number"],
  input[type="url"] {
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 6px;
    padding: 7px 10px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
    line-height: 18px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
    outline: none;
    width: 100%;
  }
  @layer components {
    textarea,
    select {
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 6px;
      padding: 7px 10px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 13px;
      line-height: 18px;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
      outline: none;
      width: 100%;
    }
  }
  input:focus,
  textarea:focus,
  select:focus {
    border-color: var(--brand);
    box-shadow: 0 0 0 3px var(--ring);
  }
  select option {
    background: var(--surface-800);
    color: var(--text-primary);
  }

  /* Buttons */
  .btn-primary {
    background: var(--brand);
    color: var(--brand-foreground);
    font-weight: 500;
    padding: 7px 14px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    transition: background-color 0.15s ease;
    font-family: inherit;
    font-size: 13px;
  }
  .btn-primary:hover { background: var(--brand-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-ghost {
    background: var(--surface-900);
    color: var(--text-primary);
    font-weight: 500;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--input-border);
    cursor: pointer;
    transition: background-color 0.15s ease;
    font-family: inherit;
    font-size: 13px;
  }
  .btn-ghost:hover { background: var(--surface-700); }
  .btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-primary:focus-visible,
  .btn-ghost:focus-visible,
  .theme-toggle:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--ring);
  }

  .theme-toggle {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 6px;
    cursor: pointer;
    color: var(--text-secondary);
    transition: background-color 0.15s ease, color 0.15s ease;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .theme-toggle:hover { background: var(--surface-700); color: var(--text-primary); }

  .text-themed { color: var(--text-primary); }
  .text-themed-secondary { color: var(--text-secondary); }
  .text-themed-dim { color: var(--text-dim); }
  .border-themed { border-color: var(--border-color); }

  .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  ```

  `body::before` 噪点纹理规则在替换 B 的范围内，替换后自然不存在。

  Task 1 加的固定调色板 `@theme` 块这一期保留：它让页面里的 `amber-400`、`emerald-500` 这类默认色维持原样。第二期逐页迁移时，再把这些类换成语义色（`danger`、`warn`、`success`、`info`），最后去掉这个块。

- [ ] **Step 3: 其余样式里的旧字体名**

  ```bash
  sed -i '' 's/"IBM Plex Mono", monospace/var(--font-mono)/g; s/"Outfit", system-ui, sans-serif/var(--font-sans)/g' apps/dashboard/src/styles.css
  grep -n 'Outfit\|IBM Plex' apps/dashboard/src/styles.css apps/dashboard/src -r
  ```

  对 grep 找到的剩余位置：
  - `TimeSeriesChart.tsx` 中图表字体的 `family: "Outfit, sans-serif"` 改为 `family: "Geist, ui-sans-serif, system-ui, sans-serif"`；
  - 其他 `.tsx` 中的字体名同样改为 Geist 或 Geist Mono（等宽场合）。

  最终 grep 应无输出。

- [ ] **Step 4: 构建并检查**

  ```bash
  bun run build:ui
  bun test apps/dashboard 2>&1 | grep -E "^ *[0-9]+ (pass|fail)$"
  (cd apps/dashboard && bun run typecheck)
  ```

  预期构建成功、0 fail、类型检查无报错。此时页面仍然是顶部 Tab，但颜色和字体已经换新。

---

### Task 3: `src/ui` 基础组件

**Files:**
- Create: `apps/dashboard/src/ui/cn.ts`、`apps/dashboard/src/ui/button.tsx`、`apps/dashboard/src/ui/tooltip.tsx`、`apps/dashboard/src/ui/dropdown-menu.tsx`、`apps/dashboard/src/ui/sheet.tsx`
- Test: `apps/dashboard/src/ui/ui.test.tsx`

第一期只建外框要用的组件；选择框、表格、弹窗等组件在第二期由第一个用到它们的页面引入。

- [ ] **Step 1: 写失败的测试**

  `apps/dashboard/src/ui/ui.test.tsx`：

  ```tsx
  import { expect, test } from "bun:test"
  import { renderToStaticMarkup } from "react-dom/server"
  import { cn } from "./cn"
  import { Button } from "./button"
  import { Tooltip } from "./tooltip"

  test("cn lets a later Tailwind class win and drops falsy parts", () => {
    expect(cn("px-2 py-1", false, undefined, "px-4")).toBe("py-1 px-4")
  })

  test("Button is a type=button by default so it never submits a form by accident", () => {
    const html = renderToStaticMarkup(<Button>Save</Button>)
    expect(html).toContain('type="button"')
    expect(html).toContain(">Save</button>")
  })

  test("Button variants map to the semantic tokens", () => {
    expect(renderToStaticMarkup(<Button variant="primary">Go</Button>)).toContain("bg-brand")
    expect(renderToStaticMarkup(<Button variant="danger">Del</Button>)).toContain("bg-danger")
  })

  test("Button asChild renders the child element instead of a button", () => {
    const html = renderToStaticMarkup(<Button asChild variant="ghost"><a href="#keys">Keys</a></Button>)
    expect(html.startsWith("<a")).toBe(true)
    expect(html).toContain('href="#keys"')
    expect(html).not.toContain("type=")
  })

  test("a disabled Tooltip renders only its trigger", () => {
    expect(renderToStaticMarkup(<Tooltip content="Usage" disabled><span>icon</span></Tooltip>)).toBe("<span>icon</span>")
  })
  ```

- [ ] **Step 2: 运行，确认失败**

  Run: `bun test apps/dashboard/src/ui/ui.test.tsx`
  Expected: FAIL，提示 `Cannot find module './cn'`。

- [ ] **Step 3: 实现**

  `apps/dashboard/src/ui/cn.ts`：

  ```ts
  import { clsx, type ClassValue } from "clsx"
  import { twMerge } from "tailwind-merge"

  /** Join class names; on a Tailwind conflict the later class wins. */
  export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs))
  }
  ```

  `apps/dashboard/src/ui/button.tsx`：

  ```tsx
  import { Slot } from "@radix-ui/react-slot"
  import { cva, type VariantProps } from "class-variance-authority"
  import type { ButtonHTMLAttributes, Ref } from "react"
  import { cn } from "./cn"

  export const buttonVariants = cva(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text [&_svg]:size-4 [&_svg]:shrink-0",
    {
      variants: {
        variant: {
          primary: "bg-brand text-brand-fg hover:bg-brand-hover",
          secondary: "border border-control bg-background text-fg hover:bg-muted",
          ghost: "text-fg-muted hover:bg-muted hover:text-fg",
          danger: "bg-danger text-white hover:opacity-90",
        },
        size: {
          sm: "h-7 px-2.5",
          md: "h-8 px-3",
          icon: "size-8 p-0",
        },
      },
      defaultVariants: { variant: "secondary", size: "md" },
    },
  )

  export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
    /** Render the single child (e.g. an <a>) with button styling instead of a <button>. */
    asChild?: boolean
    ref?: Ref<HTMLButtonElement>
  }

  export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
    const classes = cn(buttonVariants({ variant, size }), className)
    if (asChild) return <Slot className={classes} {...props} />
    return <button type={type ?? "button"} className={classes} {...props} />
  }
  ```

  `apps/dashboard/src/ui/tooltip.tsx`：

  ```tsx
  import * as RadixTooltip from "@radix-ui/react-tooltip"
  import type { ReactElement, ReactNode } from "react"
  import { cn } from "./cn"

  export const TooltipProvider = RadixTooltip.Provider

  interface TooltipProps {
    content: ReactNode
    children: ReactElement
    side?: "top" | "right" | "bottom" | "left"
    /** Render the trigger alone, e.g. when the label is already visible. */
    disabled?: boolean
  }

  export function Tooltip({ content, children, side = "right", disabled = false }: TooltipProps) {
    if (disabled) return children
    return (
      <RadixTooltip.Root delayDuration={200}>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={6}
            className={cn("z-50 rounded-md border border-border bg-fg px-2 py-1 text-xs text-background shadow-md")}
          >
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    )
  }
  ```

  `apps/dashboard/src/ui/dropdown-menu.tsx`：

  ```tsx
  import * as Menu from "@radix-ui/react-dropdown-menu"
  import type { ComponentProps } from "react"
  import { cn } from "./cn"

  export const DropdownMenu = Menu.Root
  export const DropdownMenuTrigger = Menu.Trigger

  export function DropdownMenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Menu.Content>) {
    return (
      <Menu.Portal>
        <Menu.Content
          sideOffset={sideOffset}
          className={cn("z-50 min-w-56 rounded-lg border border-border bg-background p-1 text-fg shadow-lg", className)}
          {...props}
        />
      </Menu.Portal>
    )
  }

  export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
    return (
      <Menu.Item
        className={cn(
          "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-fg-muted outline-none data-[highlighted]:bg-muted data-[highlighted]:text-fg data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4",
          className,
        )}
        {...props}
      />
    )
  }

  export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
    return <Menu.Label className={cn("px-2 py-1.5", className)} {...props} />
  }

  export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Menu.Separator>) {
    return <Menu.Separator className={cn("my-1 h-px bg-border", className)} {...props} />
  }
  ```

  `apps/dashboard/src/ui/sheet.tsx`：

  ```tsx
  import * as Dialog from "@radix-ui/react-dialog"
  import { X } from "lucide-react"
  import type { ReactNode } from "react"
  import { cn } from "./cn"

  interface SheetProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** Read out by screen readers when the sheet opens; visually hidden. */
    title: string
    closeLabel: string
    children: ReactNode
    className?: string
  }

  /** A panel that slides in from the left edge, with focus trapped inside and Esc to close. */
  export function Sheet({ open, onOpenChange, title, closeLabel, children, className }: SheetProps) {
    return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content
            aria-describedby={undefined}
            className={cn("fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-panel shadow-xl outline-none", className)}
          >
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
            <Dialog.Close
              aria-label={closeLabel}
              className="absolute right-2 top-2 rounded-md p-1.5 text-fg-muted hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
            >
              <X className="size-4" />
            </Dialog.Close>
            {children}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }
  ```

- [ ] **Step 4: 运行，确认通过**

  Run: `bun test apps/dashboard/src/ui/ui.test.tsx && (cd apps/dashboard && bun run typecheck)`
  Expected: 5 pass；类型检查无报错。

  如果 `cn` 的测试输出顺序不同：tailwind-merge 保留后出现的冲突类，并保持其余类原有的相对顺序，预期值就是 `"py-1 px-4"`。若实际不符，以库的真实输出为准修正断言，并在报告中注明。

---

### Task 4: 导航模型

**Files:**
- Create: `apps/dashboard/src/shell/navigation.ts`
- Test: `apps/dashboard/src/shell/navigation.test.ts`

- [ ] **Step 1: 写失败的测试**

  `apps/dashboard/src/shell/navigation.test.ts`：

  ```ts
  import { expect, test } from "bun:test"
  import { ChartColumn } from "lucide-react"
  import { allowedTabIds, buildNavGroups, DEFAULT_TAB, filterNavGroups, locateTab, type NavConfigGroup } from "./navigation"

  const t = (key: string) => key
  const ids = (groups: ReturnType<typeof buildNavGroups>) => groups.map((g) => [g.id, g.items.map((i) => i.id)])

  test("an admin sees every page, grouped observe → models → access → connect", () => {
    expect(ids(buildNavGroups(t, { isAdmin: true }))).toEqual([
      ["observe", ["usage", "latency"]],
      ["models", ["models", "pricing"]],
      ["access", ["keys", "users"]],
      ["connect", ["upstreams", "proxies", "clients"]],
    ])
  })

  test("a non-admin loses Users and Proxies and nothing else", () => {
    expect(ids(buildNavGroups(t, { isAdmin: false }))).toEqual([
      ["observe", ["usage", "latency"]],
      ["models", ["models", "pricing"]],
      ["access", ["keys"]],
      ["connect", ["upstreams", "clients"]],
    ])
  })

  test("a group left with no visible page is dropped", () => {
    const config: NavConfigGroup[] = [
      { id: "a", label: "A", items: [{ id: "x", label: "X", icon: ChartColumn, adminOnly: true }] },
      { id: "b", label: "B", items: [{ id: "y", label: "Y", icon: ChartColumn }] },
    ]
    expect(filterNavGroups(config, { isAdmin: false }).map((g) => g.id)).toEqual(["b"])
  })

  test("labels come from the dictionary keys", () => {
    const [observe] = buildNavGroups(t, { isAdmin: true })
    expect(observe?.label).toBe("dash.nav.groupObserve")
    expect(observe?.items[0]?.label).toBe("dash.usage")
  })

  test("the default page is Usage, which every viewer can see", () => {
    expect(DEFAULT_TAB).toBe("usage")
    expect(allowedTabIds(buildNavGroups(t, { isAdmin: false }))).toContain(DEFAULT_TAB)
  })

  test("pages outside the sidebar stay reachable by their old addresses", () => {
    const allowed = allowedTabIds(buildNavGroups(t, { isAdmin: true }))
    for (const id of ["upstreams", "proxies", "users", "keys", "models", "pricing", "usage", "latency", "clients", "agent-remote", "settings"]) {
      expect(allowed).toContain(id)
    }
  })

  test("locateTab names the group for the breadcrumb, and nothing for hidden pages", () => {
    const groups = buildNavGroups(t, { isAdmin: true })
    expect(locateTab(groups, "keys")).toEqual({ group: "dash.nav.groupAccess", page: "dash.apiKeys" })
    expect(locateTab(groups, "settings")).toEqual({ group: null, page: null })
  })
  ```

- [ ] **Step 2: 运行，确认失败**

  Run: `bun test apps/dashboard/src/shell/navigation.test.ts`
  Expected: FAIL，提示 `Cannot find module './navigation'`。

- [ ] **Step 3: 实现**

  `apps/dashboard/src/shell/navigation.ts`：

  ```ts
  import type { LucideIcon } from "lucide-react"
  import { Activity, ChartColumn, Boxes, Cable, CircleDollarSign, KeyRound, Network, RadioTower, Users } from "lucide-react"

  export interface NavItem {
    /** The hash address, e.g. "usage" for #usage. */
    id: string
    label: string
    icon: LucideIcon
  }

  export interface NavGroup {
    id: string
    label: string
    items: NavItem[]
  }

  export interface NavConfigGroup {
    id: string
    label: string
    items: Array<NavItem & { adminOnly?: boolean }>
  }

  export interface NavViewer {
    isAdmin: boolean
  }

  type Translate = (key: string) => string

  /** Where /dashboard lands when the address names no page. */
  export const DEFAULT_TAB = "usage"

  /** Pages reached from elsewhere (the account menu, the Agent Remote entry), not from the groups. */
  export const OFF_NAV_TABS = ["agent-remote", "settings"] as const

  // Keys are written out literally so the i18n coverage test can see them.
  function navConfig(t: Translate): NavConfigGroup[] {
    return [
      {
        id: "observe",
        label: t("dash.nav.groupObserve"),
        items: [
          { id: "usage", label: t("dash.usage"), icon: ChartColumn },
          { id: "latency", label: t("dash.latency"), icon: Activity },
        ],
      },
      {
        id: "models",
        label: t("dash.nav.groupModels"),
        items: [
          { id: "models", label: t("dash.models"), icon: Boxes },
          { id: "pricing", label: t("dash.pricing"), icon: CircleDollarSign },
        ],
      },
      {
        id: "access",
        label: t("dash.nav.groupAccess"),
        items: [
          { id: "keys", label: t("dash.apiKeys"), icon: KeyRound },
          { id: "users", label: t("dash.users"), icon: Users, adminOnly: true },
        ],
      },
      {
        id: "connect",
        label: t("dash.nav.groupConnect"),
        items: [
          { id: "upstreams", label: t("dash.upstream"), icon: Cable },
          { id: "proxies", label: t("dash.proxies"), icon: Network, adminOnly: true },
          { id: "clients", label: t("dash.relays"), icon: RadioTower },
        ],
      },
    ]
  }

  export function filterNavGroups(config: NavConfigGroup[], viewer: NavViewer): NavGroup[] {
    return config
      .map((group) => ({
        id: group.id,
        label: group.label,
        items: group.items
          .filter((item) => viewer.isAdmin || !item.adminOnly)
          .map(({ id, label, icon }) => ({ id, label, icon })),
      }))
      .filter((group) => group.items.length > 0)
  }

  export function buildNavGroups(t: Translate, viewer: NavViewer): NavGroup[] {
    return filterNavGroups(navConfig(t), viewer)
  }

  export function allowedTabIds(groups: NavGroup[]): string[] {
    return [...groups.flatMap((g) => g.items.map((i) => i.id)), ...OFF_NAV_TABS]
  }

  /** The group and page names for the breadcrumb; both null for a page outside the groups. */
  export function locateTab(groups: NavGroup[], tab: string): { group: string | null; page: string | null } {
    for (const group of groups) {
      const item = group.items.find((i) => i.id === tab)
      if (item) return { group: group.label, page: item.label }
    }
    return { group: null, page: null }
  }
  ```

- [ ] **Step 4: 运行，确认通过**

  Run: `bun test apps/dashboard/src/shell/navigation.test.ts`
  Expected: 7 pass。

  如果 `ChartColumn` 在 lucide-react 1.71 中被标为弃用、导致类型检查或 lint 报错，改用 `ChartColumn`（测试中的导入同步修改）。

---

### Task 5: 外框组件并接入 App

**Files:**
- Create: `apps/dashboard/src/shell/use-media-query.ts`、`apps/dashboard/src/shell/use-theme.ts`、`apps/dashboard/src/shell/SidebarNav.tsx`、`apps/dashboard/src/shell/Sidebar.tsx`、`apps/dashboard/src/shell/MobileTopBar.tsx`、`apps/dashboard/src/shell/PageCrumb.tsx`、`apps/dashboard/src/shell/AppShell.tsx`
- Modify: `apps/dashboard/src/components/UserMenu.tsx:20-131`（仅 `UserMenu` 函数）、`apps/dashboard/src/components/AgentRemoteEntry.tsx`、`apps/dashboard/src/App.tsx`
- Delete: `apps/dashboard/src/components/Layout.tsx`
- Test: `apps/dashboard/src/shell/shell.test.tsx`

- [ ] **Step 1: 写失败的测试**

  `apps/dashboard/src/shell/shell.test.tsx`：

  ```tsx
  import { expect, test } from "bun:test"
  import { renderToStaticMarkup } from "react-dom/server"
  import { TooltipProvider } from "../ui/tooltip"
  import { buildNavGroups } from "./navigation"
  import { PageCrumb } from "./PageCrumb"
  import { SidebarNav } from "./SidebarNav"

  const t = (key: string) => key
  const render = (isAdmin: boolean, current = "usage") =>
    renderToStaticMarkup(
      <TooltipProvider>
        <SidebarNav groups={buildNavGroups(t, { isAdmin })} current={current} onSelect={() => {}} collapsible={false} />
      </TooltipProvider>,
    )

  test("every sidebar page is a real link to its old hash address", () => {
    const html = render(true)
    for (const id of ["usage", "latency", "models", "pricing", "keys", "users", "upstreams", "proxies", "clients"]) {
      expect(html).toContain(`href="#${id}"`)
    }
  })

  test("the current page is marked for assistive technology", () => {
    const html = render(true, "keys")
    expect(html).toMatch(/href="#keys"[^>]*aria-current="page"|aria-current="page"[^>]*href="#keys"/)
    expect(html.match(/aria-current="page"/g)?.length).toBe(1)
  })

  test("groups are labelled lists, and a non-admin gets no Users or Proxies link", () => {
    const html = render(false)
    expect(html).toContain('role="group"')
    expect(html).toContain("dash.nav.groupObserve")
    expect(html).not.toContain('href="#users"')
    expect(html).not.toContain('href="#proxies"')
  })

  test("the breadcrumb shows group and page, or just the title off the sidebar", () => {
    expect(renderToStaticMarkup(<PageCrumb group="Observe" page="Usage" fallback="" />)).toContain("Observe")
    const off = renderToStaticMarkup(<PageCrumb group={null} page={null} fallback="Settings" />)
    expect(off).toContain("Settings")
    expect(off).toContain('aria-current="page"')
  })
  ```

- [ ] **Step 2: 运行，确认失败**

  Run: `bun test apps/dashboard/src/shell/shell.test.tsx`
  Expected: FAIL，提示找不到 `./PageCrumb`。

- [ ] **Step 3: 两个 hook**

  `apps/dashboard/src/shell/use-media-query.ts`：

  ```ts
  import { useSyncExternalStore } from "react"

  /** Whether a CSS media query matches, kept live. `fallback` is used where there is no window (tests, SSR). */
  export function useMediaQuery(query: string, fallback: boolean): boolean {
    return useSyncExternalStore(
      (onChange) => {
        const list = window.matchMedia(query)
        list.addEventListener("change", onChange)
        return () => list.removeEventListener("change", onChange)
      },
      () => window.matchMedia(query).matches,
      () => fallback,
    )
  }
  ```

  `apps/dashboard/src/shell/use-theme.ts`：

  ```ts
  import { useSyncExternalStore } from "react"

  declare global {
    interface Window {
      toggleTheme?: () => void
    }
  }

  // page.ts owns the theme: it sets <html data-theme>, persists it and fires
  // "theme-changed". This only reads it back and asks page.ts to flip it.
  export function useTheme(): { theme: "light" | "dark"; toggle: () => void } {
    const theme = useSyncExternalStore(
      (onChange) => {
        window.addEventListener("theme-changed", onChange)
        return () => window.removeEventListener("theme-changed", onChange)
      },
      () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"),
      () => "dark" as const,
    )
    return { theme, toggle: () => window.toggleTheme?.() }
  }
  ```

- [ ] **Step 4: 导航列表和面包屑**

  `apps/dashboard/src/shell/SidebarNav.tsx`：

  ```tsx
  import { useT } from "../state/i18n"
  import { cn } from "../ui/cn"
  import { Tooltip } from "../ui/tooltip"
  import type { NavGroup, NavItem } from "./navigation"
  import { useMediaQuery } from "./use-media-query"

  interface Props {
    groups: NavGroup[]
    current: string
    onSelect: (id: string) => void
    /** Shrink to icons between the phone and desktop breakpoints. False inside the phone drawer. */
    collapsible: boolean
  }

  export function SidebarNav({ groups, current, onSelect, collapsible }: Props) {
    const t = useT()
    const wide = useMediaQuery("(min-width: 1024px)", true)
    const iconOnly = collapsible && !wide
    return (
      <nav aria-label={t("dash.nav.label")} className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.id} role="group" aria-labelledby={`nav-group-${group.id}`}>
            <div
              id={`nav-group-${group.id}`}
              className={cn("px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-fg-subtle", iconOnly && "sr-only")}
            >
              {group.label}
            </div>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.id}>
                  <NavLink item={item} active={item.id === current} iconOnly={iconOnly} onSelect={onSelect} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    )
  }

  function NavLink({ item, active, iconOnly, onSelect }: { item: NavItem; active: boolean; iconOnly: boolean; onSelect: (id: string) => void }) {
    const Icon = item.icon
    return (
      <Tooltip content={item.label} disabled={!iconOnly}>
        <a
          href={`#${item.id}`}
          aria-current={active ? "page" : undefined}
          aria-label={iconOnly ? item.label : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
            e.preventDefault()
            onSelect(item.id)
          }}
          className={cn(
            "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
            active ? "bg-muted font-medium text-fg" : "text-fg-muted hover:bg-muted hover:text-fg",
            iconOnly && "justify-center px-0",
          )}
        >
          <Icon className={cn("size-4 shrink-0", active ? "text-brand" : "")} aria-hidden="true" />
          {iconOnly ? null : <span className="truncate">{item.label}</span>}
        </a>
      </Tooltip>
    )
  }
  ```

  `apps/dashboard/src/shell/PageCrumb.tsx`：

  ```tsx
  import { useT } from "../state/i18n"

  interface Props {
    group: string | null
    page: string | null
    /** Title for pages outside the groups (Settings, Agent Remote). */
    fallback: string
  }

  export function PageCrumb({ group, page, fallback }: Props) {
    const t = useT()
    return (
      <nav aria-label={t("dash.nav.breadcrumb")} className="mb-4 hidden text-[13px] md:block">
        <ol className="flex items-center gap-1.5 text-fg-subtle">
          {group ? (
            <>
              <li>{group}</li>
              <li aria-hidden="true">/</li>
            </>
          ) : null}
          <li aria-current="page" className="font-medium text-fg">{page ?? fallback}</li>
        </ol>
      </nav>
    )
  }
  ```

- [ ] **Step 5: Agent Remote 条目改为侧栏样式**

  把 `apps/dashboard/src/components/AgentRemoteEntry.tsx` 整个替换为下面的内容（启用条件、`href` 与原来一致；`AgentRemoteEntry.test.tsx` 不改，应继续通过）：

  ```tsx
  import { Bot } from "lucide-react"
  import { useEffect, useState } from "react"
  import { api } from "../api/client"
  import { useAuth } from "../state/auth"
  import { cn } from "../ui/cn"
  import { Tooltip } from "../ui/tooltip"

  export function AgentRemoteLink({ enabled, authenticated, active = false, iconOnly = false }: { enabled: boolean; authenticated: boolean; active?: boolean; iconOnly?: boolean }) {
    if (!enabled || !authenticated) return null
    return (
      <Tooltip content="Agent Remote" disabled={!iconOnly}>
        <a
          href="#agent-remote"
          aria-current={active ? "page" : undefined}
          aria-label={iconOnly ? "Agent Remote" : undefined}
          className={cn(
            "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
            active ? "bg-muted font-medium text-fg" : "text-fg-muted hover:bg-muted hover:text-fg",
            iconOnly && "justify-center px-0",
          )}
        >
          <Bot className={cn("size-4 shrink-0", active ? "text-brand" : "")} aria-hidden="true" />
          {iconOnly ? null : <span className="truncate">Agent Remote</span>}
        </a>
      </Tooltip>
    )
  }

  export function AgentRemoteEntry({ active = false, iconOnly = false }: { active?: boolean; iconOnly?: boolean }) {
    const { session } = useAuth()
    const [enabled, setEnabled] = useState(false)
    useEffect(() => {
      const controller = new AbortController()
      api<{ enabled: boolean }>("/api/agent-remote/config", { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setEnabled(result.enabled === true) })
        .catch(() => { if (!controller.signal.aborted) setEnabled(false) })
      return () => controller.abort()
    }, [])
    return <AgentRemoteLink active={active} iconOnly={iconOnly} enabled={enabled} authenticated={session?.sessionToken?.startsWith("ses_") === true} />
  }
  ```

  `AgentRemoteEntry.test.tsx` 渲染 `AgentRemoteLink` 时外层没有 `TooltipProvider`。因为 `iconOnly` 默认为 false，Tooltip 被禁用、只渲染触发元素，所以不需要 Provider，测试应继续通过。

- [ ] **Step 6: 账户菜单改用 Radix**

  在 `apps/dashboard/src/components/UserMenu.tsx` 中：
  - 把 `export function UserMenu(...)` 整个函数，以及紧随其后的 `function MenuItem(...)`，替换为下面的代码；
  - 文件中 `MySharingModal`、`ChangePasswordModal`、各个 `Icon*` 组件以及其余内容不动；如果替换后某个 `Icon*` 不再被引用，删除它，以免 lint 报未使用；
  - 把文件顶部的 `import { useEffect, useRef, useState } from "react"` 改为只导入仍在使用的 hook（`MySharingModal` 等内部可能仍需要 `useEffect`、`useState`），按类型检查结果调整。

  新增导入：

  ```tsx
  import { ChevronsUpDown, Lock, LogOut, Settings, Share2 } from "lucide-react"
  import { cn } from "../ui/cn"
  import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu"
  ```

  替换后的 `UserMenu`：

  ```tsx
  interface Props {
    onNavigate: (tab: string) => void
    canNavigateSettings: boolean
    /** Avatar only, for the icon-width sidebar. */
    compact?: boolean
  }

  export function UserMenu({ onNavigate, canNavigateSettings, compact = false }: Props) {
    const { session, logout } = useAuth()
    const t = useT()
    const [sharingOpen, setSharingOpen] = useState(false)
    const [pwdOpen, setPwdOpen] = useState(false)
    const [failedAvatar, setFailedAvatar] = useState<string | null>(null)

    if (!session) return null
    const initial = (session.userName || session.email || "?")[0]?.toUpperCase() ?? "?"
    const isAdmin = session.isAdmin === true
    const isUser = session.isUser === true
    const hasPassword = session.hasPassword === true
    const displayName = session.userName || session.email || (isAdmin ? "Admin" : "")

    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("dash.nav.account")}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text data-[state=open]:bg-muted",
              compact && "justify-center",
            )}
          >
            {session.avatarUrl && session.avatarUrl !== failedAvatar ? (
              <img
                src={session.avatarUrl}
                alt=""
                className="size-7 shrink-0 rounded-full"
                referrerPolicy="no-referrer"
                onError={() => setFailedAvatar(session.avatarUrl ?? null)}
              />
            ) : (
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-violet/15 text-xs font-medium text-accent-violet">
                {initial}
              </span>
            )}
            {compact ? null : (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-fg">{displayName}</span>
                  {session.email && session.email !== displayName ? (
                    <span className="block truncate text-xs text-fg-subtle">{session.email}</span>
                  ) : null}
                </span>
                <ChevronsUpDown className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
              </>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            <DropdownMenuLabel>
              <div className="truncate text-[13px] font-medium text-fg">{session.userName || ""}</div>
              <div className="truncate text-xs text-fg-subtle">{session.email || ""}</div>
              {isAdmin ? (
                <span className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium uppercase bg-accent-violet/10 text-accent-violet">
                  {t("dash.adminLabel")}
                </span>
              ) : null}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {isAdmin && canNavigateSettings ? (
              <DropdownMenuItem onSelect={() => onNavigate("settings")}>
                <Settings aria-hidden="true" />
                {t("dash.settingsMenu")}
              </DropdownMenuItem>
            ) : null}
            {isUser ? (
              <DropdownMenuItem onSelect={() => setSharingOpen(true)}>
                <Share2 aria-hidden="true" />
                {t("dash.mySharingLabel")}
              </DropdownMenuItem>
            ) : null}
            {hasPassword ? (
              <DropdownMenuItem onSelect={() => setPwdOpen(true)}>
                <Lock aria-hidden="true" />
                {t("dash.changePasswordMenu")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => logout()} className="text-danger data-[highlighted]:text-danger">
              <LogOut aria-hidden="true" />
              {t("dash.signOutMenu")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <MySharingModal open={sharingOpen} onClose={() => setSharingOpen(false)} />
        <ChangePasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
      </>
    )
  }
  ```

  显示条件与原来逐项一致：
  - 设置：管理员且 `canNavigateSettings`；
  - 共享：`isUser`；
  - 修改密码：`hasPassword`；
  - 退出：始终显示。

- [ ] **Step 7: 侧栏、手机顶栏和整体布局**

  `apps/dashboard/src/shell/Sidebar.tsx`：

  ```tsx
  import { Languages, Moon, Sun } from "lucide-react"
  import { AgentRemoteEntry } from "../components/AgentRemoteEntry"
  import { UserMenu } from "../components/UserMenu"
  import { useT } from "../state/i18n"
  import { cn } from "../ui/cn"
  import { Tooltip } from "../ui/tooltip"
  import type { NavGroup } from "./navigation"
  import { SidebarNav } from "./SidebarNav"
  import { useMediaQuery } from "./use-media-query"
  import { useTheme } from "./use-theme"

  interface Props {
    groups: NavGroup[]
    current: string
    onSelect: (id: string) => void
    /** False inside the phone drawer, where the full labels always fit. */
    collapsible: boolean
    className?: string
  }

  export function SidebarContent({ groups, current, onSelect, collapsible, className }: Props) {
    const t = useT()
    const wide = useMediaQuery("(min-width: 1024px)", true)
    const iconOnly = collapsible && !wide
    const { theme, toggle } = useTheme()
    const zh = typeof window !== "undefined" && window.__lang === "zh"

    return (
      <div className={cn("flex h-full flex-col gap-4 p-3", iconOnly && "items-stretch px-2", className)}>
        <div className={cn("flex h-8 items-center gap-2 px-2", iconOnly && "justify-center px-0")}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand text-brand-fg">
            <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </span>
          {iconOnly ? <span className="sr-only">Copilot Gateway</span> : <span className="truncate text-sm font-semibold tracking-tight text-fg">Copilot Gateway</span>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <SidebarNav groups={groups} current={current} onSelect={onSelect} collapsible={collapsible} />
        </div>

        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <AgentRemoteEntry active={current === "agent-remote"} iconOnly={iconOnly} />
          <UserMenu onNavigate={onSelect} canNavigateSettings={true} compact={iconOnly} />
          <div className={cn("flex gap-1", iconOnly ? "flex-col items-center" : "px-1")}>
            <Tooltip content={t("dash.nav.toggleLanguage")} side={iconOnly ? "right" : "top"}>
              <button type="button" className="theme-toggle size-8" aria-label={t("dash.nav.toggleLanguage")} onClick={() => window.toggleLang?.()}>
                <Languages className="size-4" aria-hidden="true" />
                <span className="sr-only">{zh ? "English" : "中文"}</span>
              </button>
            </Tooltip>
            <Tooltip content={t("dash.nav.toggleTheme")} side={iconOnly ? "right" : "top"}>
              <button type="button" className="theme-toggle size-8" aria-label={t("dash.nav.toggleTheme")} onClick={toggle}>
                {theme === "dark" ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    )
  }

  /** The fixed sidebar from the tablet breakpoint up; icons only below 1024px. */
  export function Sidebar(props: Omit<Props, "collapsible" | "className">) {
    return (
      <aside className="hidden w-14 shrink-0 border-r border-border bg-panel md:block lg:w-60">
        <SidebarContent {...props} collapsible={true} />
      </aside>
    )
  }
  ```

  `apps/dashboard/src/shell/MobileTopBar.tsx`：

  ```tsx
  import { Menu } from "lucide-react"
  import { useState } from "react"
  import { UserMenu } from "../components/UserMenu"
  import { useT } from "../state/i18n"
  import { Sheet } from "../ui/sheet"
  import type { NavGroup } from "./navigation"
  import { SidebarContent } from "./Sidebar"

  interface Props {
    groups: NavGroup[]
    current: string
    title: string
    onSelect: (id: string) => void
  }

  /** Phones only: a thin bar with the page name, and the full sidebar in a drawer. */
  export function MobileTopBar({ groups, current, title, onSelect }: Props) {
    const t = useT()
    const [open, setOpen] = useState(false)
    const select = (id: string) => {
      setOpen(false)
      onSelect(id)
    }
    return (
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-panel px-2 md:hidden">
        <button type="button" className="theme-toggle size-9" aria-label={t("dash.nav.openMenu")} aria-expanded={open} onClick={() => setOpen(true)}>
          <Menu className="size-5" aria-hidden="true" />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</span>
        <div className="w-10">
          <UserMenu onNavigate={select} canNavigateSettings={true} compact={true} />
        </div>
        <Sheet open={open} onOpenChange={setOpen} title={t("dash.nav.label")} closeLabel={t("dash.nav.closeMenu")}>
          <SidebarContent groups={groups} current={current} onSelect={select} collapsible={false} />
        </Sheet>
      </header>
    )
  }
  ```

  `apps/dashboard/src/shell/AppShell.tsx`：

  ```tsx
  import type { ReactNode } from "react"
  import { TooltipProvider } from "../ui/tooltip"
  import { locateTab, type NavGroup } from "./navigation"
  import { MobileTopBar } from "./MobileTopBar"
  import { PageCrumb } from "./PageCrumb"
  import { Sidebar } from "./Sidebar"

  interface Props {
    groups: NavGroup[]
    current: string
    onSelect: (id: string) => void
    /** Title for the pages outside the groups, keyed by tab id. */
    offNavTitles: Record<string, string>
    children: ReactNode
  }

  export function AppShell({ groups, current, onSelect, offNavTitles, children }: Props) {
    const { group, page } = locateTab(groups, current)
    const title = page ?? offNavTitles[current] ?? ""
    return (
      <TooltipProvider>
        <div className="flex h-screen overflow-hidden bg-background text-fg">
          <Sidebar groups={groups} current={current} onSelect={onSelect} />
          <div className="flex min-w-0 flex-1 flex-col">
            <MobileTopBar groups={groups} current={current} title={title} onSelect={onSelect} />
            {/* Same box as the old Layout's <main>: tabs such as the chat playground
                rely on a min-h-0 flex column to fill the height. */}
            <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-6">
              <PageCrumb group={group} page={page} fallback={title} />
              {children}
            </main>
          </div>
        </div>
      </TooltipProvider>
    )
  }
  ```

- [ ] **Step 8: App.tsx 接入**

  在 `apps/dashboard/src/App.tsx` 中：
  - 删除 `import { Layout } from "./components/Layout"`、`TabDef` 接口、`ALL_TABS`、`HIDDEN_FROM_NAV_TABS`；
  - 新增导入 `import { AppShell } from "./shell/AppShell"` 和 `import { allowedTabIds, buildNavGroups, DEFAULT_TAB } from "./shell/navigation"`；
  - 把 `Shell` 函数替换为：

  ```tsx
  function Shell() {
    const { loading, session, error } = useAuth()
    const t = useT()

    const groups = useMemo(() => (session ? buildNavGroups(t, { isAdmin: session.isAdmin === true }) : []), [session, t])
    const allowedIds = useMemo(() => allowedTabIds(groups), [groups])
    const [tab, setTab] = useHashTab(DEFAULT_TAB, allowedIds)
    const offNavTitles = useMemo(() => ({ "agent-remote": t("dash.remote.title"), settings: t("dash.settings") }), [t])

    if (loading) {
      return <div className="min-h-screen flex items-center justify-center text-themed-dim">Loading…</div>
    }
    if (error) {
      return <div className="min-h-screen flex items-center justify-center text-accent-red text-sm">{error}</div>
    }
    if (!session) return null

    return (
      <AppShell groups={groups} current={tab} onSelect={setTab} offNavTitles={offNavTitles}>
        <TabBody tab={tab} />
      </AppShell>
    )
  }
  ```

  `TabBody`、`App` 不变。然后删除 `components/Layout.tsx`：`git rm -q apps/dashboard/src/components/Layout.tsx`。

  确认其他地方没有再引用 Layout：

  ```bash
  grep -rn "components/Layout\|from \"./Layout\"" apps/dashboard/src
  ```

  预期无输出。

  行为说明：
  - `useHashTab(DEFAULT_TAB, …)` 在地址里没有页面或页面不允许访问时落到"用量"。这一点原来取决于 `visibleTabs[0]`（即"上游"）。
  - `Settings` 原来对所有人都在允许列表里（入口只给管理员），现在仍通过 `OFF_NAV_TABS` 对所有人允许，行为不变。

- [ ] **Step 9: 运行测试和类型检查**

  ```bash
  bun test apps/dashboard 2>&1 | grep -E "^ *[0-9]+ (pass|fail)$|^\(fail\)"
  (cd apps/dashboard && bun run typecheck)
  ```

  预期：0 fail，包括 `shell.test.tsx` 的 4 个和原有的 `AgentRemoteEntry.test.tsx`；类型检查无报错。

  i18n 测试要等 Task 6 加上文案后才会通过，在这里失败是预期的。

---

### Task 6: 导航文案

**Files:**
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts`

- [ ] **Step 1: 运行，确认失败**

  Run: `bun test packages/gateway/tests/i18n-keys.test.ts`
  Expected: FAIL，缺少 `dash.nav.*` 键。

- [ ] **Step 2: 加文案**

  在英文字典中 `"dash.latency": "Latency",` 一行之后加入：

  ```ts
        "dash.nav.label": "Dashboard navigation",
        "dash.nav.breadcrumb": "Breadcrumb",
        "dash.nav.groupObserve": "Observe",
        "dash.nav.groupModels": "Models",
        "dash.nav.groupAccess": "Access",
        "dash.nav.groupConnect": "Connect",
        "dash.nav.account": "Account",
        "dash.nav.openMenu": "Open navigation",
        "dash.nav.closeMenu": "Close navigation",
        "dash.nav.toggleLanguage": "Switch language / 切换语言",
        "dash.nav.toggleTheme": "Switch light or dark theme",
  ```

  在中文字典中 `"dash.latency": "延迟",` 一行之后加入：

  ```ts
        "dash.nav.label": "控制台导航",
        "dash.nav.breadcrumb": "当前位置",
        "dash.nav.groupObserve": "观测",
        "dash.nav.groupModels": "模型",
        "dash.nav.groupAccess": "访问",
        "dash.nav.groupConnect": "接入",
        "dash.nav.account": "账户",
        "dash.nav.openMenu": "打开导航",
        "dash.nav.closeMenu": "关闭导航",
        "dash.nav.toggleLanguage": "切换语言 / Switch language",
        "dash.nav.toggleTheme": "切换浅色或深色主题",
  ```

- [ ] **Step 3: 运行，确认通过**

  Run: `bun test packages/gateway/tests/i18n-keys.test.ts apps/dashboard 2>&1 | grep -E "^ *[0-9]+ (pass|fail)$"`
  Expected: 0 fail。

---

### Task 7: 浏览器验证、体积、全量检查

**Files:** 无代码改动（发现问题时回到对应任务修正）。

- [ ] **Step 1: 构建并记录体积**

  ```bash
  bun run build:ui
  F=packages/gateway/src/shared/edge/ui-pages/dashboard-app/dist
  wc -c < $F/dashboard.js; gzip -c $F/dashboard.js | wc -c; wc -c < $F/dashboard.css
  ```

  与基线对比：js 893,422 字节，gzip 275,726 字节。增加量要在 300 KB 以内，超出时找出原因（例如 lucide 没有按图标单独引入）并修正。

- [ ] **Step 2: 预览环境逐项检查**

  按附录 A 起预览环境。每一项都截图保存到 `$S/t7-<编号>-<说明>.png`。

  1. 打开 `http://127.0.0.1:41498/admin`（地址里没有 hash），落在"用量"页；面包屑显示"观测 / 用量"。
  2. 管理员看到四组共 9 个页面；底部依次是 Agent Remote（只在本地启用时出现）、账户行、语言和主题按钮。
  3. 依次点击侧栏的 9 个页面，每页都能正常显示原有内容，当前项高亮。
  4. 用地址直接打开 `#settings` 和 `#agent-remote`（后者需要已启用），面包屑只显示页面名。
  5. 账户菜单：
     - 显示名字、邮箱和管理员标识；
     - "设置"进入设置页；
     - "修改密码"能打开原来的弹窗（如果该账户有密码）；
     - "退出"退出登录；
     - 菜单可以用键盘打开（Tab 聚焦、Enter），用方向键选择，Esc 关闭。
  6. 语言按钮切到英文再切回来，主题按钮切换浅色和深色。
  7. 用量页（月视图）的图表字体为 Geist；模型页的聊天面板仍然撑满高度。
  8. 打开 `http://127.0.0.1:41498/user` 以普通用户登录：侧栏里没有"用户"和"代理"，账户菜单里没有"设置"。
  9. 宽度 900：侧栏只剩图标，悬停时显示页面名，底部的账户行只剩头像。
  10. 宽度 390：侧栏隐藏，出现顶栏。点击菜单按钮，抽屉滑出，内容是完整侧栏；选择一个页面后抽屉关闭并跳转；Esc 和关闭按钮都能关闭抽屉。
  11. 以上第 2、3、9、10 项在浅色和深色、中文和英文下各看一遍。
  12. 在用量页对 `http://127.0.0.1:41499/dashboard#usage` 跑 Lighthouse 无障碍审计，记录分数，以及对比度、标签方面的问题。

  把逐页浏览时看到的、属于页面内部而非外框的别扭之处，例如页面内重复的标题、仍是旧样式的控件、写死的颜色，列成清单，留给第二期。

- [ ] **Step 3: 清理预览环境**

  执行附录 A 的清理命令。

- [ ] **Step 4: 全量检查**

  ```bash
  bun run build:setup
  bun run ci:local
  ```

  - `bun test` 全量运行要 10 分钟以上，Bash 工具的 10 分钟上限可能不够。可以先用 `nohup bun test > /tmp/dr-test.log 2>&1 &` 在后台跑，再分别运行 `bun run typecheck`、`bun run lint`、`bun run build:ui`，以及 `bun run --filter '@vibe-llm/platform-cloudflare' deploy:dry`。
  - 已知与本次无关的失败：`docs/superpowers/research/.../reference-adapter.test.ts`（研究用脚本，依赖特定环境）；以及高负载下 `usage-detail-capacity` 偶发超时，单独重跑应通过。
  - 除此之外应 0 fail；lint 不应出现本次改动文件的新警告。

- [ ] **Step 5: 交付给主控**

  报告内容：
  - 各任务完成情况；
  - Task 1 的截图对比结论；
  - 体积变化；
  - 第 2 步的截图路径；
  - Lighthouse 结果；
  - 留给第二期的问题清单。

  不要提交。由主控向用户汇报，用户确认后分两个提交：
  1. `build(vnext/dashboard): move to Tailwind 4`：Task 1；
  2. `feat(vnext/dashboard): grouped sidebar and a calmer visual system`：其余任务，以及本计划和设计文档。
