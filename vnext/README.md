# vNext

下一代网关重构，与根目录 `src/` 旧项目并存。

## 结构

```
vnext/
├── apps/
│   ├── gateway/      # Hono on Cloudflare Workers + Bun（待引入）
│   └── dashboard/    # React 19 + Vite（待引入）
└── packages/
    ├── protocols/    # 纯类型 + Zod schemas（无运行时副作用）
    └── translate/    # 协议翻译器（纯函数）
```

## 依赖方向（不可违反）

```
protocols  ← translate  ← gateway
                       ↖ dashboard
```

- `protocols` 不依赖任何包
- `translate` 仅依赖 `protocols`
- `gateway`、`dashboard` 都可依赖 `protocols` 与 `translate`
- 反向依赖一律禁止；后续靠 ESLint `no-restricted-paths` 强制

## 安装

```sh
cd vnext && bun install
```

## 类型检查

```sh
bun run typecheck   # 触发所有 workspace 的 tsc --noEmit
```

## 状态

骨架阶段：所有包仅有 `export {}` 占位，逐步迁入业务代码。旧 `src/` 继续承担生产流量，互不干扰。
